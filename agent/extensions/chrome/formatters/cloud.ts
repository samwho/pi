import type { ToolFormatter } from "./types.ts";
import {
	body,
	count,
	entity,
	envelope,
	items,
	join,
	listSummary,
	namedFields,
	object,
	reference,
	text,
	tokens,
} from "./shared.ts";

// Exact methods observed in the 2026-11-03..17 history audit, per connection.
const connections: Record<string, string[]> = {
	laravel_cloud: [
		"list_environments",
		"list_applications",
		"get_deployment",
		"stop_environment",
		"update_environment",
		"list_organizations",
		"get_environment_logs",
		"update_instance",
		"get_skill",
		"start_environment",
		"create_application",
		"create_deployment",
		"list_instances",
		"get_command",
		"get_deployment_logs",
		"list_database_types",
		"run_command",
		"list_regions",
		"list_instance_sizes",
		"list_source_control_accounts",
		"list_databases",
		"list_deployments",
		"attach_resource",
		"get_environment",
		"list_database_schemas",
		"get_usage",
		"create_bucket",
		"create_bucket_key",
		"list_buckets",
		"get_environment_replicas",
		"set_environment_variables",
	],
	laravel_cloud_personal: [
		"get_deployment",
		"verify_domain",
		"update_environment",
		"list_applications",
		"get_environment",
		"get_usage",
		"list_organizations",
		"list_environments",
		"create_deployment",
		"create_application",
		"list_instances",
		"update_instance",
		"create_domain",
		"list_deployments",
		"get_deployment_logs",
		"get_skill",
		"get_domain",
		"list_instance_sizes",
		"delete_application",
		"update_application",
		"purge_edge_cache",
		"list_regions",
		"list_source_control_accounts",
		"list_database_types",
		"list_databases",
	],
};
const labels: Record<string, string> = {
	get_skill: "guide",
	get_environment_logs: "environment logs",
	get_deployment_logs: "deployment logs",
	get_usage: "usage",
	get_environment_replicas: "replicas",
	list_source_control_accounts: "source accounts",
	list_instance_sizes: "instance sizes",
	list_database_types: "database types",
	list_database_schemas: "database schemas",
	get_command: "command",
	run_command: "run command",
	set_environment_variables: "set variables",
	attach_resource: "attach resource",
	purge_edge_cache: "purge cache",
};
const lists: Record<string, [string, string?]> = {
	list_environments: ["environment"],
	list_applications: ["application"],
	list_organizations: ["organization"],
	list_instances: ["instance"],
	list_deployments: ["deployment"],
	list_databases: ["database"],
	list_buckets: ["bucket"],
	list_regions: ["region"],
	list_source_control_accounts: ["account"],
	list_database_types: ["database type"],
	list_database_schemas: ["schema"],
};
function target(args: Record<string, unknown>): string {
	return (
		reference(args.environment_id, "env") ||
		reference(args.application_id, "app") ||
		reference(args.deployment_id) ||
		reference(args.instance_id) ||
		reference(args.domain_id) ||
		reference(args.command_id) ||
		reference(args.database_id, "database") ||
		reference(args.bucket_id, "bucket") ||
		reference(args.organization_id, "org")
	);
}

const cloud: ToolFormatter[] = Object.entries(connections).flatMap(([server, operations]) =>
	operations.map((operation): ToolFormatter => ({
		tools: [`mcp__${server}__${operation}`],
		call(args) {
			const action =
				labels[operation] ?? operation.replace(/^(?:list|get)_/, "").replace(/_/g, " ");
			const label = `${server === "laravel_cloud_personal" ? "cloud personal" : "cloud"} ${action}`;
			let subject = target(args);
			if (operation === "get_skill") subject = text(args.name);
			else if (operation === "create_application")
				subject = join(args.name, args.repository, args.region);
			else if (operation === "create_bucket" || operation === "create_domain")
				subject = join(args.name, target(args));
			else if (
				operation === "update_environment" ||
				operation === "update_instance" ||
				operation === "update_application"
			)
				subject = join(
					subject,
					namedFields(args, ["organization_id", "environment_id", "instance_id", "application_id"]),
				);
			else if (operation === "set_environment_variables")
				subject = join(
					subject,
					Array.isArray(args.variables) ? count(args.variables.length, "variable") : "",
					args.method,
				);
			else if (operation === "attach_resource")
				subject = join(subject, args.resource_type, reference(args.resource_id));
			else if (operation === "create_bucket_key")
				subject = join(subject, args.name, args.permission);
			else if (operation === "get_environment_logs")
				subject = join(subject, args.type ?? "all", args.query, args.from, args.to);
			else if (operation === "get_usage")
				subject = join(subject, `period ${typeof args.period === "number" ? args.period : 0}`);
			else if (operation === "purge_edge_cache")
				subject = join(
					subject,
					args.path || args.prefix || (args.tag ? "selected tags" : "all paths"),
				);
			if (lists[operation] && typeof args.page === "number")
				subject = join(subject, `page ${args.page}`);
			return { label, subject };
		},
		result(result, context) {
			if (lists[operation]) {
				const [singular, plural] = lists[operation];
				const summary = listSummary(result, ["data"], singular, plural);
				return summary === undefined ? undefined : { summary };
			}
			const root = envelope(result);
			const data = entity(result);
			if (operation === "get_skill") return { summary: tokens(context.tokens) };
			if (operation === "delete_application")
				return /https?:\/\//.test(body(result))
					? { summary: "confirmation required · not deleted" }
					: undefined;
			if (operation === "list_instance_sizes") {
				const groups = object(root?.data);
				if (Array.isArray(groups.general) && Array.isArray(groups.managed_queue))
					return {
						summary: join(
							count(groups.general.length, "general size"),
							count(groups.managed_queue.length, "queue size"),
						),
					};
				return undefined;
			}
			if (operation === "get_environment_logs") {
				const rows = items(result, ["data"]);
				return {
					summary: join(
						rows ? count(rows.length, "entry", "entries") : "",
						tokens(context.tokens),
						object(root?.meta).cursor ? "more available" : "",
					),
				};
			}
			if (operation === "get_deployment_logs") {
				const rows = items(result, ["data"]);
				return {
					summary: join(
						object(root?.meta).deployment_status,
						rows ? count(rows.length, "step") : "",
						tokens(context.tokens),
					),
				};
			}
			if (operation === "get_usage") {
				const summary = object(object(root?.data).summary);
				const cents = summary.current_spend_cents;
				return typeof cents === "number" && Number.isFinite(cents)
					? { summary: `$${(cents / 100).toFixed(2)} USD spend` }
					: undefined;
			}
			if (!data) return undefined;
			if (
				operation === "create_domain" ||
				operation === "get_domain" ||
				operation === "verify_domain"
			) {
				const summary = join(
					text(data.hostname_status) ? `DNS ${text(data.hostname_status)}` : "",
					text(data.ssl_status) ? `SSL ${text(data.ssl_status)}` : "",
					data.action_required ? "action required" : "",
				);
				return summary ? { subject: text(data.name) || undefined, summary } : undefined;
			}
			if (
				operation === "update_environment" ||
				operation === "update_instance" ||
				operation === "set_environment_variables" ||
				operation === "attach_resource"
			)
				return data.id || data.status ? { summary: "configured · deploy required" } : undefined;
			if (operation === "get_environment_replicas") {
				const total = data.total_replicas ?? data.total;
				return typeof total === "number" ? { summary: count(total, "replica") } : undefined;
			}
			if (operation === "get_command" || operation === "run_command") {
				const summary = join(
					data.status,
					typeof data.exit_code === "number" ? `exit ${data.exit_code}` : "",
					operation === "get_command" ? tokens(context.tokens) : "",
				);
				return summary ? { summary } : undefined;
			}
			if (operation === "purge_edge_cache")
				return data.id || data.status ? { summary: "purge requested" } : undefined;
			if (operation === "create_bucket_key")
				return data.id || data.name ? { summary: join("key created", data.permission) } : undefined;
			if (operation === "update_application" && data.id && data.name)
				return { subject: text(data.name), summary: "updated" };
			const summary = join(
				data.status,
				data.branch_name,
				typeof data.commit_hash === "string" ? data.commit_hash.slice(0, 7) : "",
			);
			return summary
				? {
						subject: operation === "get_environment" ? text(data.name) || undefined : undefined,
						summary,
					}
				: undefined;
		},
		unavailableSummary: lists[operation]
			? `? ${lists[operation][1] ?? lists[operation][0] + "s"}`
			: undefined,
	})),
);
export default cloud;
