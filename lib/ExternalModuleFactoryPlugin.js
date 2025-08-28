/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

/**
 * ExternalModuleFactoryPlugin - Webpack 外部依赖处理插件
 *
 * ===== 插件概述 =====
 * 该插件负责处理 webpack 配置中的外部依赖（externals），将指定的模块标记为外部模块，
 * 在打包时不会被包含在 bundle 中，而是在运行时从外部环境获取（如 CDN、全局变量等）。
 *
 * ===== 核心功能 =====
 * 1. 外部依赖识别：在模块工厂化过程中识别配置的外部依赖
 * 2. 多格式支持：支持字符串、数组、正则、函数、对象等多种配置格式
 * 3. 类型处理：支持 commonjs、amd、global、module 等外部类型
 * 4. 元数据收集：为不同类型的依赖收集相应的元数据信息
 * 5. 缓存优化：通过层级缓存提升重复解析的性能
 *
 * ===== 工作流程 =====
 * 1. 插件注册到 normalModuleFactory.hooks.factorize 钩子
 * 2. 在模块工厂化阶段拦截每个模块请求
 * 3. 根据配置的 externals 规则判断是否为外部依赖
 * 4. 如果匹配，创建 ExternalModule 实例替代普通模块
 * 5. 如果不匹配，回退到原始的模块工厂处理流程
 *
 * ===== 应用场景 =====
 * - CDN 依赖：React、Vue 等从 CDN 加载，减少 bundle 体积
 * - Node.js 环境：排除内置模块和 node_modules 依赖
 * - 微前端：共享模块由主应用提供，子应用不重复打包
 * - 第三方库：已有全局变量的库不需要重复打包
 */

"use strict";

const util = require("util");
const ExternalModule = require("./ExternalModule");
const ContextElementDependency = require("./dependencies/ContextElementDependency");
const CssImportDependency = require("./dependencies/CssImportDependency");
const CssUrlDependency = require("./dependencies/CssUrlDependency");
const HarmonyImportDependency = require("./dependencies/HarmonyImportDependency");
const ImportDependency = require("./dependencies/ImportDependency");
const { cachedSetProperty, resolveByProperty } = require("./util/cleverMerge");

/** @typedef {import("../declarations/WebpackOptions").ExternalItemFunctionData} ExternalItemFunctionData */
/** @typedef {import("../declarations/WebpackOptions").ExternalItemObjectKnown} ExternalItemObjectKnown */
/** @typedef {import("../declarations/WebpackOptions").ExternalItemObjectUnknown} ExternalItemObjectUnknown */
/** @typedef {import("../declarations/WebpackOptions").Externals} Externals */
/** @typedef {import("./Compilation").DepConstructor} DepConstructor */
/** @typedef {import("./ExternalModule").DependencyMeta} DependencyMeta */
/** @typedef {import("./Module")} Module */
/** @typedef {import("./ModuleFactory").IssuerLayer} IssuerLayer */
/** @typedef {import("./NormalModuleFactory")} NormalModuleFactory */

// ===== 常量定义 =====

/**
 * 用于检测未指定类型的外部模块配置
 * 匹配格式如: "commonjs react", "amd lodash", "global jQuery"
 * 即在字符串开头有类型名称 + 空格 + 模块名的格式
 */
const UNSPECIFIED_EXTERNAL_TYPE_REGEXP = /^[a-z0-9-]+ /;

/** 空的解析选项，用于默认情况 */
const EMPTY_RESOLVE_OPTIONS = {};

// ===== 向后兼容性处理 =====

/**
 * 弃用的外部函数调用方式（webpack 6 将移除）
 * 旧版本的外部函数接收 (context, request, callback) 三个参数
 * 新版本应使用 ({context, request}, callback) 对象参数形式
 */
// TODO webpack 6 remove this
const callDeprecatedExternals = util.deprecate(
	/**
	 * @param {EXPECTED_FUNCTION} externalsFunction externals function
	 * @param {string} context context
	 * @param {string} request request
	 * @param {(err: Error | null | undefined, value: ExternalValue | undefined, ty: ExternalType | undefined) => void} cb cb
	 */
	(externalsFunction, context, request, cb) => {
		// eslint-disable-next-line no-useless-call
		externalsFunction.call(null, context, request, cb);
	},
	"The externals-function should be defined like ({context, request}, cb) => { ... }",
	"DEP_WEBPACK_EXTERNALS_FUNCTION_PARAMETERS"
);

/** @typedef {ExternalItemObjectKnown & ExternalItemObjectUnknown} ExternalItemObject */

/**
 * @template {ExternalItemObject} T
 * @typedef {WeakMap<T, Map<IssuerLayer, Omit<T, "byLayer">>>} ExternalWeakCache
 */

// ===== 层级缓存机制 =====

/**
 * 外部配置的层级缓存，用于优化性能
 * 当外部配置对象包含 byLayer 属性时，会按照层级进行解析
 * 缓存结果可以避免重复计算，提高性能
 * @type {ExternalWeakCache<ExternalItemObject>}
 */
/** @type {ExternalWeakCache<ExternalItemObject>} */
const cache = new WeakMap();

/**
 * 按照层级解析外部配置对象
 * 支持在不同层级下使用不同的外部配置，实现精细化控制
 * @param {ExternalItemObject} obj 外部配置对象
 * @param {IssuerLayer} layer 当前层级
 * @returns {Omit<ExternalItemObject, "byLayer">} 解析后的配置（移除 byLayer 属性）
 */
const resolveLayer = (obj, layer) => {
	// 检查缓存中是否已有该对象的解析结果
	let map = cache.get(obj);
	if (map === undefined) {
		// 初次解析，创建新的 Map 存储不同层级的结果
		map = new Map();
		cache.set(obj, map);
	} else {
		// 检查是否已有该层级的缓存结果
		const cacheEntry = map.get(layer);
		if (cacheEntry !== undefined) return cacheEntry;
	}

	// 按照层级解析配置对象，移除 byLayer 属性
	const result = resolveByProperty(obj, "byLayer", layer);

	// 将解析结果缓存起来
	map.set(layer, result);
	return result;
};

/** @typedef {string | string[] | boolean | Record<string, string | string[]>} ExternalValue */
/** @typedef {string | undefined} ExternalType */

// ===== 主要插件类 =====

const PLUGIN_NAME = "ExternalModuleFactoryPlugin";

/**
 * Webpack 外部模块工厂插件
 *
 * 该插件在模块工厂化阶段介入，判断模块请求是否为外部依赖。
 * 如果匹配外部配置，则创建 ExternalModule 实例替代正常的模块处理流程。
 *
 * 工作原理：
 * 1. 监听 normalModuleFactory.hooks.factorize 钩子
 * 2. 在每个模块创建时检查是否为外部依赖
 * 3. 支持多种外部配置格式（字符串、数组、正则、函数、对象）
 * 4. 处理外部类型和元数据信息
 */
class ExternalModuleFactoryPlugin {
	/**
	 * 构造函数 - 初始化外部模块工厂插件
	 * @param {string | undefined} type 默认外部类型（如 "global"、"commonjs" 等）
	 * @param {Externals} externals 外部配置，支持多种格式
	 */
	constructor(type, externals) {
		this.type = type;
		this.externals = externals;
	}

	/**
	 * 插件应用方法 - 将插件注册到模块工厂
	 *
	 * 该方法会在 NormalModuleFactory 的 factorize 钩子上注册处理函数，
	 * 在每个模块请求进入工厂化阶段时进行外部依赖判断。
	 *
	 * 执行时机：
	 * - 在模块创建之前，在 factorizeQueue 处理阶段
	 * - 在 NormalModuleFactory 处理模块请求之前
	 * @param {NormalModuleFactory} normalModuleFactory 正常模块工厂实例
	 * @returns {void}
	 */
	apply(normalModuleFactory) {
		// 存储全局配置的外部类型
		const globalType = this.type;

		// 注册到 factorize 钩子，在模块工厂化阶段介入
		normalModuleFactory.hooks.factorize.tapAsync(
			PLUGIN_NAME,
			(data, callback) => {
				// 提取模块请求相关信息
				const context = data.context; // 上下文目录
				const contextInfo = data.contextInfo; // 上下文信息
				const dependency = data.dependencies[0]; // 依赖对象
				const dependencyType = data.dependencyType; // 依赖类型

				// ===== 外部依赖处理函数 =====

				/** @typedef {(err?: Error | null, externalModule?: ExternalModule) => void} HandleExternalCallback */

				/**
				 * 处理单个外部依赖的核心函数
				 *
				 * 该函数负责：
				 * 1. 解析外部配置值和类型
				 * 2. 从配置字符串中提取类型信息（如 "commonjs react"）
				 * 3. 收集不同类型依赖的元数据（ES6 模块、CSS 导入等）
				 * 4. 创建 ExternalModule 实例
				 * @param {ExternalValue} value 外部配置值（字符串、数组、对象或布尔值）
				 * @param {ExternalType | undefined} type 外部类型（可选）
				 * @param {HandleExternalCallback} callback 回调函数
				 * @returns {void}
				 */
				const handleExternal = (value, type, callback) => {
					if (value === false) {
						// 不是外部依赖，回退到原始的模块工厂处理流程
						return callback();
					}

					// 准备外部配置：true 表示使用原始请求名，否则使用指定的配置
					/** @type {string | string[] | Record<string, string|string[]>} */
					let externalConfig = value === true ? dependency.request : value;

					// 当没有明确指定类型时，从 externalConfig 中提取类型
					if (type === undefined) {
						if (
							typeof externalConfig === "string" &&
							UNSPECIFIED_EXTERNAL_TYPE_REGEXP.test(externalConfig)
						) {
							// 处理字符串格式："commonjs react" -> type="commonjs", config="react"
							const idx = externalConfig.indexOf(" ");
							type = externalConfig.slice(0, idx);
							externalConfig = externalConfig.slice(idx + 1);
						} else if (
							Array.isArray(externalConfig) &&
							externalConfig.length > 0 &&
							UNSPECIFIED_EXTERNAL_TYPE_REGEXP.test(externalConfig[0])
						) {
							// 处理数组格式：["commonjs react", "lodash"] -> type="commonjs", config=["react", "lodash"]
							const firstItem = externalConfig[0];
							const idx = firstItem.indexOf(" ");
							type = firstItem.slice(0, idx);
							externalConfig = [
								firstItem.slice(idx + 1),
								...externalConfig.slice(1)
							];
						}
					}

					// 解析最终的外部类型：优先使用显式指定的类型，其次使用全局类型
					const resolvedType = /** @type {string} */ (type || globalType);

					// ===== 依赖元数据收集 =====
					// 根据不同的依赖类型收集相应的元数据信息
					// TODO make it pluggable/add hooks to `ExternalModule` to allow output modules own externals?
					/** @type {DependencyMeta | undefined} */
					let dependencyMeta;

					if (
						dependency instanceof HarmonyImportDependency ||
						dependency instanceof ImportDependency ||
						dependency instanceof ContextElementDependency
					) {
						// 处理 ES6 模块和动态导入的元数据
						const externalType =
							dependency instanceof HarmonyImportDependency
								? "module" // ES6 模块导入
								: dependency instanceof ImportDependency
									? "import" // 动态 import()
									: undefined; // 上下文元素依赖

						dependencyMeta = {
							attributes: dependency.assertions, // import assertions（如 import json from './data.json' assert { type: 'json' }）
							externalType
						};
					} else if (dependency instanceof CssImportDependency) {
						// 处理 CSS @import 的元数据
						dependencyMeta = {
							layer: dependency.layer, // CSS 层级
							supports: dependency.supports, // CSS @supports
							media: dependency.media // CSS 媒体查询
						};
					}

					if (
						resolvedType === "asset" &&
						dependency instanceof CssUrlDependency
					) {
						// 处理 CSS url() 的资源类型
						dependencyMeta = { sourceType: "css-url" };
					}

					// 创建并返回 ExternalModule 实例
					// 该实例将替代正常的 NormalModule，在打包时不会包含实际代码
					callback(
						null,
						new ExternalModule(
							externalConfig, // 外部配置（字符串、数组或对象）
							resolvedType, // 解析后的外部类型
							dependency.request, // 原始请求字符串
							dependencyMeta // 依赖元数据
						)
					);
				};

				// ===== 外部配置处理函数 =====

				/**
				 * 处理各种形式的外部配置
				 *
				 * 支持的配置格式：
				 * 1. 字符串：直接匹配模块名
				 * 2. 数组：多个外部配置的组合
				 * 3. 正则表达式：模式匹配
				 * 4. 函数：动态判断逻辑
				 * 5. 对象：键值对映射
				 * @param {Externals} externals 外部配置
				 * @param {HandleExternalCallback} callback 回调函数
				 * @returns {void}
				 */
				const handleExternals = (externals, callback) => {
					// ===== 字符串配置处理 =====
					if (typeof externals === "string") {
						// 直接字符串匹配：externals: "react"
						if (externals === dependency.request) {
							return handleExternal(dependency.request, undefined, callback);
						}
					} else if (Array.isArray(externals)) {
						// ===== 数组配置处理 =====
						// 递归处理数组中的每一项，直到找到匹配项或处理完所有项
						// 数组处理的异步逻辑，逐个处理数组元素
						let i = 0;
						const next = () => {
							/** @type {boolean | undefined} */
							let asyncFlag; // 用于控制异步执行流程
							/**
							 * 处理单个外部配置并调用回调
							 * @param {(Error | null)=} err 错误信息
							 * @param {ExternalModule=} module 外部模块实例
							 * @returns {void}
							 */
							const handleExternalsAndCallback = (err, module) => {
								if (err) return callback(err);
								if (!module) {
									// 当前项不匹配，继续处理下一项
									if (asyncFlag) {
										asyncFlag = false;
										return;
									}
									return next();
								}
								// 找到匹配的外部模块，直接返回
								callback(null, module);
							};

							// 同步循环处理数组元素，直到遇到异步操作
							do {
								asyncFlag = true;
								if (i >= externals.length) return callback(); // 数组处理完成
								handleExternals(externals[i++], handleExternalsAndCallback);
							} while (!asyncFlag); // 如果是异步操作，退出循环
							asyncFlag = false;
						};

						next();
						return;
					} else if (externals instanceof RegExp) {
						// ===== 正则表达式配置处理 =====
						// 使用正则表达式匹配模块请求
						if (externals.test(dependency.request)) {
							return handleExternal(dependency.request, undefined, callback);
						}
					} else if (typeof externals === "function") {
						// ===== 函数配置处理 =====
						// 支持动态判断逻辑，可以根据上下文和请求参数做决定
						/**
						 * 外部函数的回调处理函数
						 * @param {Error | null | undefined} err 错误信息
						 * @param {ExternalValue=} value 外部配置值
						 * @param {ExternalType=} type 外部类型
						 * @returns {void}
						 */
						const cb = (err, value, type) => {
							if (err) return callback(err);
							if (value !== undefined) {
								// 函数返回了外部配置，进一步处理
								handleExternal(value, type, callback);
							} else {
								// 函数返回 undefined，表示不是外部依赖
								callback();
							}
						};
						if (externals.length === 3) {
							// TODO webpack 6 remove this
							callDeprecatedExternals(
								externals,
								context,
								dependency.request,
								cb
							);
						} else {
							const promise = externals(
								{
									context,
									request: dependency.request,
									dependencyType,
									contextInfo,
									getResolve: (options) => (context, request, callback) => {
										const resolveContext = {
											fileDependencies: data.fileDependencies,
											missingDependencies: data.missingDependencies,
											contextDependencies: data.contextDependencies
										};
										let resolver = normalModuleFactory.getResolver(
											"normal",
											dependencyType
												? cachedSetProperty(
														data.resolveOptions || EMPTY_RESOLVE_OPTIONS,
														"dependencyType",
														dependencyType
													)
												: data.resolveOptions
										);
										if (options) resolver = resolver.withOptions(options);
										if (callback) {
											resolver.resolve(
												{},
												context,
												request,
												resolveContext,
												callback
											);
										} else {
											return new Promise((resolve, reject) => {
												resolver.resolve(
													{},
													context,
													request,
													resolveContext,
													(err, result) => {
														if (err) reject(err);
														else resolve(result);
													}
												);
											});
										}
									}
								},
								cb
							);
							if (promise && promise.then) promise.then((r) => cb(null, r), cb);
						}
						return;
					} else if (typeof externals === "object") {
						const resolvedExternals = resolveLayer(
							externals,
							/** @type {IssuerLayer} */
							(contextInfo.issuerLayer)
						);
						if (
							Object.prototype.hasOwnProperty.call(
								resolvedExternals,
								dependency.request
							)
						) {
							return handleExternal(
								resolvedExternals[dependency.request],
								undefined,
								callback
							);
						}
					}
					callback();
				};

				handleExternals(this.externals, callback);
			}
		);
	}
}

module.exports = ExternalModuleFactoryPlugin;
