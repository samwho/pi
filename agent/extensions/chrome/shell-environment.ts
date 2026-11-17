import { isAbsolute, resolve } from "node:path";

export type ShellEnvironment = {
	cwd?: string;
	path?: string;
	home?: string;
	pwd?: string;
	oldpwd?: string;
	functions: ReadonlySet<string>;
	unknownCommands: boolean;
};
export type AnalysedCommand = {
	word: Record<string, unknown>;
	command?: string;
	environment: ShellEnvironment;
};
const VARIABLES = { PATH: "path", HOME: "home", PWD: "pwd", OLDPWD: "oldpwd" } as const;
const PARAM_KEYS = new Set(["Type", "Pos", "End", "Dollar", "Short", "Param", "Rbrace"]);
function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
function array(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}
function variable(name: string): (typeof VARIABLES)[keyof typeof VARIABLES] | undefined {
	return Object.hasOwn(VARIABLES, name) ? VARIABLES[name as keyof typeof VARIABLES] : undefined;
}
function uncertain(state: ShellEnvironment): ShellEnvironment {
	return {
		...state,
		cwd: undefined,
		path: undefined,
		home: undefined,
		pwd: undefined,
		oldpwd: undefined,
		functions: new Set(),
		unknownCommands: true,
	};
}
function merge(left: ShellEnvironment, right: ShellEnvironment): ShellEnvironment {
	return {
		cwd: left.cwd === right.cwd ? left.cwd : undefined,
		path: left.path === right.path ? left.path : undefined,
		home: left.home === right.home ? left.home : undefined,
		pwd: left.pwd === right.pwd ? left.pwd : undefined,
		oldpwd: left.oldpwd === right.oldpwd ? left.oldpwd : undefined,
		functions: new Set([...left.functions].filter((name) => right.functions.has(name))),
		unknownCommands: left.unknownCommands || right.unknownCommands,
	};
}

/** Expand only static literals and simple HOME/PATH/PWD/OLDPWD references. Never eval. */
function wordValue(
	value: unknown,
	state: ShellEnvironment,
	assignment = false,
	quoted = false,
): string | undefined {
	const parts = object(value).Parts;
	if (!Array.isArray(parts)) return undefined;
	let output = "";
	for (const raw of parts as unknown[]) {
		const part = object(raw);
		let chunk: string | undefined;
		if (part.Type === "Lit" && typeof part.Value === "string") {
			const literal = part.Value;
			chunk = "";
			for (let index = 0; index < literal.length; index++) {
				const char = literal[index];
				if (char === "\\") {
					const next = literal[index + 1];
					if (next === undefined) return undefined;
					if (!quoted || '\\$`"\n'.includes(next)) {
						if (next !== "\n") chunk += next;
						index++;
					} else chunk += char;
				} else {
					if (!quoted && !assignment && "*?[".includes(char)) return undefined;
					if (
						char === "~" &&
						!quoted &&
						(output + chunk === "" || (assignment && chunk.endsWith(":")))
					) {
						if (literal[index + 1] !== undefined && !"/:".includes(literal[index + 1]))
							return undefined;
						if (state.home === undefined) return undefined;
						chunk += state.home;
					} else chunk += char;
				}
			}
		} else if (part.Type === "SglQuoted" && !part.Dollar && typeof part.Value === "string")
			chunk = part.Value;
		else if (part.Type === "DblQuoted" && !part.Dollar)
			chunk = wordValue(part, state, assignment, true);
		else if (part.Type === "ParamExp" && Object.keys(part).every((key) => PARAM_KEYS.has(key))) {
			const name = object(part.Param).Value;
			const key = typeof name === "string" ? variable(name) : undefined;
			chunk = key ? state[key] : undefined;
			if (
				!quoted &&
				!assignment &&
				chunk !== undefined &&
				(/[\s*?]/.test(chunk) || chunk.includes("["))
			)
				return undefined;
		} else return undefined;
		if (chunk === undefined) return undefined;
		output += chunk;
	}
	return output;
}

function assign(values: unknown, initial: ShellEnvironment, declaration = false): ShellEnvironment {
	let state = initial;
	const nodes = array(values);
	const flags = nodes
		.filter((node) => object(node).Naked)
		.map((node) => wordValue(object(node).Value, state, true) ?? "");
	const complex = declaration && flags.some((flag) => /^-[a-zA-Z]*[aAin]/.test(flag));
	for (const raw of nodes) {
		const node = object(raw);
		const name = object(node.Name).Value;
		const key = typeof name === "string" ? variable(name) : undefined;
		if (node.Naked) {
			if (key) continue; // `export PATH` does not change its value.
			const value = wordValue(node.Value, state, true);
			if (value === undefined) {
				state = uncertain(state);
				continue;
			}
			const match = value.match(/^(PATH|HOME|PWD|OLDPWD)(\+?)=([\s\S]*)$/);
			if (match) {
				const field = variable(match[1])!;
				const before = state[field];
				state = {
					...state,
					[field]: complex
						? undefined
						: match[2]
							? before === undefined
								? undefined
								: before + match[3]
							: match[3],
				};
			}
			continue;
		}
		if (!key) continue;
		let value = node.Value === undefined ? "" : wordValue(node.Value, state, true);
		if (node.Append)
			value = state[key] === undefined || value === undefined ? undefined : state[key] + value;
		state = {
			...state,
			[key]: complex || node.Array !== undefined || node.Index !== undefined ? undefined : value,
		};
	}
	return state;
}

/** Immutable environment snapshots for each command position in shfmt's AST. */
export function analyseCommands(ast: unknown, initial: ShellEnvironment): AnalysedCommand[] {
	const calls: AnalysedCommand[] = [];
	const visit = (value: unknown, state: ShellEnvironment): ShellEnvironment => {
		if (Array.isArray(value)) {
			let current = state;
			for (const child of value as unknown[]) current = visit(child, current);
			return current;
		}
		const node = object(value);
		if (node.Type === "File" || node.Type === "Block") return visit(node.Stmts, state);
		if (node.Cmd && !node.Type) {
			visit(node.Redirs, state);
			const next = visit(node.Cmd, state);
			return node.Background ? state : next;
		}
		if (node.Type === "BinaryCmd") {
			const left = visit(node.X, state);
			if (node.Op === "&&") return visit(node.Y, left);
			if (node.Op === "||") return merge(left, visit(node.Y, merge(state, left)));
			visit(node.Y, state); // Pipeline sides cannot change their parent's environment.
			return state;
		}
		if (node.Type === "FuncDecl") {
			const name = object(node.Name).Value;
			const next =
				typeof name === "string"
					? { ...state, functions: new Set([...state.functions, name]) }
					: state;
			visit(node.Body, uncertain(next)); // The body runs later in a caller's environment.
			return next;
		}
		if (node.Type === "DeclClause") {
			visit(node.Args, state);
			const variant = object(node.Variant).Value;
			const next = assign(node.Args, state, variant !== "export");
			return variant === "export" ? next : { ...next, unknownCommands: true };
		}
		if (node.Type === "CallExpr") {
			visit(node.Assigns, state);
			const temporary = assign(node.Assigns, state);
			const args = array(node.Args);
			if (!args.length) return temporary; // Standalone assignment persists.
			// Bash expands command words before applying temporary prefix assignments.
			visit(args, state); // Substitutions are analysed, never executed.
			const command = wordValue(args[0], state);
			calls.push({ word: object(args[0]), command, environment: temporary });
			if (
				command === undefined ||
				command === "source" ||
				command === "." ||
				command === "eval" ||
				state.functions.has(command)
			)
				return uncertain(state);
			if (command === "cd") {
				const words = args.slice(1).map((arg) => wordValue(arg, state));
				while (words[0] === "-L" || words[0] === "-P") words.shift();
				if (words[0] === "--") words.shift();
				const destination = words.length
					? words[0] === "-"
						? temporary.oldpwd
						: words[0]
					: temporary.home;
				const cwd =
					destination === undefined ||
					words.length > 1 ||
					(!isAbsolute(destination) && temporary.cwd === undefined)
						? undefined
						: resolve(temporary.cwd ?? "/", destination);
				return { ...state, cwd, pwd: cwd, oldpwd: state.pwd };
			}
			if (command === "unset") {
				const next = { ...state };
				for (const arg of args.slice(1)) {
					const name = wordValue(arg, temporary);
					const field = name === undefined ? undefined : variable(name);
					if (name === undefined) return uncertain(state);
					if (field) next[field] = undefined;
				}
				return { ...next, unknownCommands: true };
			}
			if (command === "alias" || command === "hash") return { ...state, unknownCommands: true };
			// Wrappers can invoke shell builtins/functions that mutate the environment.
			if (
				(command === "command" || command === "builtin") &&
				!args.slice(1).some((arg) => ["-v", "-V"].includes(wordValue(arg, temporary) ?? ""))
			)
				return uncertain(state);
			return state; // Prefix assignments apply only to this invocation.
		}
		// Subshells and command/process substitutions are scoped. Control-flow
		// effects, including conditional sources/eval, must not produce false reds.
		if (["Subshell", "CmdSubst", "ProcSubst"].includes(String(node.Type))) {
			visit(node.Stmts, state);
			return state;
		}
		if (["IfClause", "WhileClause", "ForClause", "CaseClause"].includes(String(node.Type))) {
			for (const child of Object.values(node))
				if (child !== null && typeof child === "object") visit(child, uncertain(state));
			return uncertain(state);
		}
		for (const child of Object.values(node))
			if (child !== null && typeof child === "object") visit(child, state);
		return state;
	};
	visit(ast, initial);
	return calls;
}
