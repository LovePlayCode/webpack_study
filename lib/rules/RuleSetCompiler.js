/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

/**
 * RuleSetCompiler - Webpack 规则编译器
 *
 * 该文件包含 Webpack 模块规则系统的核心执行逻辑，主要功能包括：
 * 1. 规则编译：将用户配置的规则转换为可执行的编译规则
 * 2. 条件匹配：根据模块信息匹配相应的规则
 * 3. 效果生成：为匹配的模块生成相应的处理效果（如加载器配置）
 *
 * 实际应用示例：
 *
 * // webpack.config.js 中的规则配置
 * module: {
 * rules: [
 * {
 * test: /\.js$/,           // 匹配 .js 文件
 * exclude: /node_modules/, // 排除 node_modules
 * use: 'babel-loader'      // 使用 babel-loader
 * },
 * {
 * test: /\.css$/,
 * oneOf: [                 // oneOf 规则：只匹配第一个
 * {
 * resourceQuery: /module/, // 如果有 ?module 查询参数
 * use: 'css-loader?modules'
 * },
 * {
 * use: 'css-loader'    // 否则使用普通 css-loader
 * }
 * ]
 * }
 * ]
 * }
 *
 * 处理文件 /src/app.js 时：
 * 1. 条件匹配：检查 data.resource 是否匹配 /\.js$/
 * 2. 排除检查：检查 data.resource 是否不匹配 /node_modules/
 * 3. 效果收集：添加 { type: "use", value: { loader: "babel-loader" } }
 * 4. 返回 true：表示规则匹配成功
 */

"use strict";

const { SyncHook } = require("tapable");

/** @typedef {import("../../declarations/WebpackOptions").Falsy} Falsy */
/** @typedef {import("../../declarations/WebpackOptions").RuleSetLoaderOptions} RuleSetLoaderOptions */
/** @typedef {import("../../declarations/WebpackOptions").RuleSetRule} RuleSetRule */
/** @typedef {import("../NormalModule").LoaderItem} LoaderItem */

/** @typedef {(Falsy | RuleSetRule)[]} RuleSetRules */

/**
 * @typedef {(value: EffectData[keyof EffectData]) => boolean} RuleConditionFunction
 */

/**
 * @typedef {object} RuleCondition
 * @property {string | string[]} property
 * @property {boolean} matchWhenEmpty
 * @property {RuleConditionFunction} fn
 */

/**
 * @typedef {object} Condition
 * @property {boolean} matchWhenEmpty
 * @property {RuleConditionFunction} fn
 */

/**
 * @typedef {object} EffectData
 * @property {string=} resource
 * @property {string=} realResource
 * @property {string=} resourceQuery
 * @property {string=} resourceFragment
 * @property {string=} scheme
 * @property {ImportAttributes=} assertions
 * @property {string=} mimetype
 * @property {string} dependency
 * @property {Record<string, EXPECTED_ANY>=} descriptionData
 * @property {string=} compiler
 * @property {string} issuer
 * @property {string} issuerLayer
 */

/**
 * @typedef {object} CompiledRule
 * @property {RuleCondition[]} conditions
 * @property {(Effect | ((effectData: EffectData) => Effect[]))[]} effects
 * @property {CompiledRule[]=} rules
 * @property {CompiledRule[]=} oneOf
 */

/** @typedef {"use" | "use-pre" | "use-post"} EffectUseType */

/**
 * @typedef {object} EffectUse
 * @property {EffectUseType} type
 * @property {{ loader: string, options?: string | null | Record<string, EXPECTED_ANY>, ident?: string }} value
 */

/**
 * @typedef {object} EffectBasic
 * @property {string} type
 * @property {EXPECTED_ANY} value
 */

/** @typedef {EffectUse | EffectBasic} Effect */

/** @typedef {Map<string, RuleSetLoaderOptions>} References */

/**
 * @typedef {object} RuleSet
 * @property {References} references map of references in the rule set (may grow over time)
 * @property {(effectData: EffectData) => Effect[]} exec execute the rule set
 */

/**
 * @template T
 * @template {T[keyof T]} V
 * @typedef {({ [P in keyof Required<T>]: Required<T>[P] extends V ? P : never })[keyof T]} KeysOfTypes
 */

/** @typedef {{ apply: (ruleSetCompiler: RuleSetCompiler) => void }} RuleSetPlugin */

class RuleSetCompiler {
	/**
	 * @param {RuleSetPlugin[]} plugins plugins
	 */
	constructor(plugins) {
		this.hooks = Object.freeze({
			/** @type {SyncHook<[string, RuleSetRule, Set<string>, CompiledRule, References]>} */
			rule: new SyncHook([
				"path",
				"rule",
				"unhandledProperties",
				"compiledRule",
				"references"
			])
		});
		if (plugins) {
			for (const plugin of plugins) {
				plugin.apply(this);
			}
		}
	}

	/**
	 * @param {RuleSetRules} ruleSet raw user provided rules
	 * @returns {RuleSet} compiled RuleSet
	 */
	compile(ruleSet) {
		const refs = new Map();
		const rules = this.compileRules("ruleSet", ruleSet, refs);

		/**
		 * 规则执行器 - Webpack 规则编译器的核心执行函数
		 * 负责根据编译后的规则来匹配模块数据并生成相应的效果(effects)
		 * 是 Webpack 模块规则系统的核心执行器，将用户配置的规则转换为实际的加载器和处理器应用逻辑
		 *
		 * 核心处理流程：
		 * 1. 条件匹配阶段：检查所有条件是否满足
		 * 2. 效果收集阶段：收集匹配规则的所有效果
		 * 3. 嵌套规则处理：递归处理子规则和oneOf规则
		 *
		 * 设计亮点：
		 * - 递归处理：支持嵌套规则的递归匹配
		 * - 短路优化：条件不匹配时立即返回 false
		 * - 灵活的效果系统：支持静态和动态效果生成
		 * - oneOf 语义：实现"第一个匹配即停止"的逻辑
		 * - 属性路径访问：支持深层嵌套属性的安全访问
		 * @param {EffectData} data 传入的数据，包含模块的各种信息(resource、issuer、resourceQuery等)
		 * @param {CompiledRule} rule 已编译的规则，包含conditions、effects、rules、oneOf等
		 * @param {Effect[]} effects 用于收集匹配效果的数组，如加载器配置等
		 * @returns {boolean} 如果规则匹配则返回 true，用于oneOf规则的短路逻辑
		 */
		const execRule = (data, rule, effects) => {
			// ===== 阶段 1：条件匹配阶段 (Condition Matching) =====
			// 遍历规则中的所有条件，只有所有条件都满足时，规则才会匹配
			// 每个条件包含：property(要检查的属性)、fn(匹配函数)、matchWhenEmpty(空值匹配策略)
			for (const condition of rule.conditions) {
				const p = condition.property;
				// 处理嵌套属性路径，如 ['descriptionData', 'type'] 或 ['resourceQuery', 'param']
				// 这允许规则检查深层嵌套的对象属性
				if (Array.isArray(p)) {
					/** @type {EffectData | EffectData[keyof EffectData] | undefined} */
					let current = data;
					// 逐层遍历属性路径，安全访问深层嵌套属性
					// 例如：['descriptionData', 'type'] 会从 data.descriptionData.type 获取值
					for (const subProperty of p) {
						if (
							current &&
							typeof current === "object" &&
							Object.prototype.hasOwnProperty.call(current, subProperty)
						) {
							// 属性存在，继续向下遍历
							current = current[/** @type {keyof EffectData} */ (subProperty)];
						} else {
							// 属性不存在，停止遍历并标记为 undefined
							current = undefined;
							break;
						}
					}
					if (current !== undefined) {
						// 属性值存在，执行条件匹配函数
						// condition.fn 可能是正则检查、字符串匹配或自定义函数
						if (!condition.fn(current)) return false;
						continue;
					}
					// 处理单一属性，如 'resource'、'issuer'、'resourceQuery' 等
					// 这些是 EffectData 对象的直接属性
				} else if (p in data) {
					const value = data[/** @type {keyof EffectData} */ (p)];
					if (value !== undefined) {
						// 属性值存在，执行条件检查
						// 例如：{ test: /\.js$/ } 会检查 resource 是否以 .js 结尾
						if (!condition.fn(value)) return false;
						continue;
					}
				}
				// 属性不存在或为空的情况下，检查是否允许空值匹配
				// matchWhenEmpty: true 表示属性为空时也认为匹配
				// matchWhenEmpty: false 表示属性为空时不匹配，整个规则失效
				if (!condition.matchWhenEmpty) {
					return false;
				}
			}
			// ===== 阶段 2：效果收集阶段 (Effects Collection) =====
			// 所有条件都匹配成功，开始收集该规则的所有效果
			// 效果可以是静态的配置对象，也可以是动态的函数
			for (const effect of rule.effects) {
				if (typeof effect === "function") {
					// 动态效果函数：根据模块数据动态生成效果
					// 例如：根据文件路径动态选择不同的加载器
					const returnedEffects = effect(data);
					for (const effect of returnedEffects) {
						effects.push(effect);
					}
				} else {
					// 静态效果：直接添加配置对象
					// 例如：{ type: "use", value: { loader: "babel-loader" } }
					effects.push(effect);
				}
			}
			// ===== 阶段 3：嵌套规则处理 (Nested Rules) =====
			// 处理子规则（全部执行）
			// rules 中的所有子规则都会被执行，用于组合多个处理规则
			if (rule.rules) {
				for (const childRule of rule.rules) {
					// 递归执行每个子规则，不管是否匹配都会继续执行
					execRule(data, childRule, effects);
				}
			}
			// 处理 oneOf 规则（只执行第一个匹配的）
			// oneOf 实现“第一个匹配即停止”的逻辑，类似 switch-case 语句
			// 常用于根据不同条件选择不同的处理方式
			if (rule.oneOf) {
				for (const childRule of rule.oneOf) {
					// 递归执行 oneOf 中的每个规则
					// 一旦找到匹配的规则（返回 true），就立即停止遍历
					if (execRule(data, childRule, effects)) {
						// 短路逻辑：找到匹配的规则后停止执行后续规则
						break;
					}
				}
			}
			// 所有处理完成，返回 true 表示规则匹配成功
			// 这个返回值对于 oneOf 规则的短路逻辑非常重要
			return true;
		};

		return {
			references: refs,
			exec: (data) => {
				/** @type {Effect[]} */
				const effects = [];
				for (const rule of rules) {
					execRule(data, rule, effects);
				}
				return effects;
			}
		};
	}

	/**
	 * @param {string} path current path
	 * @param {RuleSetRules} rules the raw rules provided by user
	 * @param {References} refs references
	 * @returns {CompiledRule[]} rules
	 */
	compileRules(path, rules, refs) {
		return rules
			.filter(Boolean)
			.map((rule, i) =>
				this.compileRule(
					`${path}[${i}]`,
					/** @type {RuleSetRule} */ (rule),
					refs
				)
			);
	}

	/**
	 * @param {string} path current path
	 * @param {RuleSetRule} rule the raw rule provided by user
	 * @param {References} refs references
	 * @returns {CompiledRule} normalized and compiled rule for processing
	 */
	compileRule(path, rule, refs) {
		/** @type {Set<string>} */
		const unhandledProperties = new Set(
			Object.keys(rule).filter(
				(key) => rule[/** @type {keyof RuleSetRule} */ (key)] !== undefined
			)
		);

		/** @type {CompiledRule} */
		const compiledRule = {
			conditions: [],
			effects: [],
			rules: undefined,
			oneOf: undefined
		};

		this.hooks.rule.call(path, rule, unhandledProperties, compiledRule, refs);

		if (unhandledProperties.has("rules")) {
			unhandledProperties.delete("rules");
			const rules = rule.rules;
			if (!Array.isArray(rules)) {
				throw this.error(path, rules, "Rule.rules must be an array of rules");
			}
			compiledRule.rules = this.compileRules(`${path}.rules`, rules, refs);
		}

		if (unhandledProperties.has("oneOf")) {
			unhandledProperties.delete("oneOf");
			const oneOf = rule.oneOf;
			if (!Array.isArray(oneOf)) {
				throw this.error(path, oneOf, "Rule.oneOf must be an array of rules");
			}
			compiledRule.oneOf = this.compileRules(`${path}.oneOf`, oneOf, refs);
		}

		if (unhandledProperties.size > 0) {
			throw this.error(
				path,
				rule,
				`Properties ${[...unhandledProperties].join(", ")} are unknown`
			);
		}

		return compiledRule;
	}

	/**
	 * @param {string} path current path
	 * @param {RuleSetLoaderOptions} condition user provided condition value
	 * @returns {Condition} compiled condition
	 */
	compileCondition(path, condition) {
		if (condition === "") {
			return {
				matchWhenEmpty: true,
				fn: (str) => str === ""
			};
		}
		if (!condition) {
			throw this.error(
				path,
				condition,
				"Expected condition but got falsy value"
			);
		}
		if (typeof condition === "string") {
			return {
				matchWhenEmpty: condition.length === 0,
				fn: (str) => typeof str === "string" && str.startsWith(condition)
			};
		}
		if (typeof condition === "function") {
			try {
				return {
					matchWhenEmpty: condition(""),
					fn: /** @type {RuleConditionFunction} */ (condition)
				};
			} catch (_err) {
				throw this.error(
					path,
					condition,
					"Evaluation of condition function threw error"
				);
			}
		}
		if (condition instanceof RegExp) {
			return {
				matchWhenEmpty: condition.test(""),
				fn: (v) => typeof v === "string" && condition.test(v)
			};
		}
		if (Array.isArray(condition)) {
			const items = condition.map((c, i) =>
				this.compileCondition(`${path}[${i}]`, c)
			);
			return this.combineConditionsOr(items);
		}

		if (typeof condition !== "object") {
			throw this.error(
				path,
				condition,
				`Unexpected ${typeof condition} when condition was expected`
			);
		}

		const conditions = [];
		for (const key of Object.keys(condition)) {
			const value = condition[key];
			switch (key) {
				case "or":
					if (value) {
						if (!Array.isArray(value)) {
							throw this.error(
								`${path}.or`,
								condition.or,
								"Expected array of conditions"
							);
						}
						conditions.push(this.compileCondition(`${path}.or`, value));
					}
					break;
				case "and":
					if (value) {
						if (!Array.isArray(value)) {
							throw this.error(
								`${path}.and`,
								condition.and,
								"Expected array of conditions"
							);
						}
						let i = 0;
						for (const item of value) {
							conditions.push(this.compileCondition(`${path}.and[${i}]`, item));
							i++;
						}
					}
					break;
				case "not":
					if (value) {
						const matcher = this.compileCondition(`${path}.not`, value);
						const fn = matcher.fn;
						conditions.push({
							matchWhenEmpty: !matcher.matchWhenEmpty,
							fn: /** @type {RuleConditionFunction} */ ((v) => !fn(v))
						});
					}
					break;
				default:
					throw this.error(
						`${path}.${key}`,
						condition[key],
						`Unexpected property ${key} in condition`
					);
			}
		}
		if (conditions.length === 0) {
			throw this.error(
				path,
				condition,
				"Expected condition, but got empty thing"
			);
		}
		return this.combineConditionsAnd(conditions);
	}

	/**
	 * @param {Condition[]} conditions some conditions
	 * @returns {Condition} merged condition
	 */
	combineConditionsOr(conditions) {
		if (conditions.length === 0) {
			return {
				matchWhenEmpty: false,
				fn: () => false
			};
		} else if (conditions.length === 1) {
			return conditions[0];
		}
		return {
			matchWhenEmpty: conditions.some((c) => c.matchWhenEmpty),
			fn: (v) => conditions.some((c) => c.fn(v))
		};
	}

	/**
	 * @param {Condition[]} conditions some conditions
	 * @returns {Condition} merged condition
	 */
	combineConditionsAnd(conditions) {
		if (conditions.length === 0) {
			return {
				matchWhenEmpty: false,
				fn: () => false
			};
		} else if (conditions.length === 1) {
			return conditions[0];
		}
		return {
			matchWhenEmpty: conditions.every((c) => c.matchWhenEmpty),
			fn: (v) => conditions.every((c) => c.fn(v))
		};
	}

	/**
	 * @param {string} path current path
	 * @param {EXPECTED_ANY} value value at the error location
	 * @param {string} message message explaining the problem
	 * @returns {Error} an error object
	 */
	error(path, value, message) {
		return new Error(
			`Compiling RuleSet failed: ${message} (at ${path}: ${value})`
		);
	}
}

module.exports = RuleSetCompiler;
