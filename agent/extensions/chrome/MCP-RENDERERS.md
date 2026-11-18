# MCP renderer audit

## Scope

- Window: 2026-11-03T10:12:18 UTC to 2026-11-17T10:12:18 UTC.
- Scanned 151 session files; 143 have entries in the window.
- 805 distinct recorded MCP invocations across 76 tool names.
- Counted direct tool calls and recorded nested calls, including errors; deduplicated copied/forked records by tool name and call ID.
- Excluded tool discovery/definition lookups and tool names merely mentioned in prose or scripts.
- Inspected the current definitions of all 76 tools. Historical codemode output supplied additional transport/field-shape evidence where available; child results themselves are not stored by Pi.
- This report contains tool names/counts only. No chat excerpts, resource identifiers, credentials, or real document titles are included.

## Grafana follow-up (2026-11-18)

A two-week scan of 177 session files found 127 distinct recorded Grafana calls
across four sessions, before validation. Counts include nested calls and exclude
tool discovery, prose, and script mentions. All seven observed methods have
formatters:

| Method | Calls |
| --- | ---: |
| `query_prometheus` | 94 |
| `search_dashboards` | 12 |
| `list_prometheus_label_names` | 7 |
| `list_prometheus_metric_names` | 5 |
| `get_dashboard_property` | 5 |
| `list_datasources` | 3 |
| `get_dashboard_panel_queries` | 1 |

PromQL headings show the expression with string literals masked, the query
mode, and the time window. Recognized results show series and sample counts.
List headings count returned entries and only say `more available` when
Grafana reports it. Dashboard property reads show the JSONPath and output-token
estimate; raw values, panel query payloads, and URLs stay in the expanded view.

```text
✓ grafana PromQL rate(http_requests_total{job="…"}[5m]) · range · now-1h → now · step 60s · 3 series · 183 samples
✓ grafana dashboards queue · starred · 4 dashboards · more available
✓ grafana dashboard property $.panels[*].title · ops-overview · ~42 tokens
```

## Connections

| Connection             | Calls |
| ---------------------- | ----: |
| laravel_cloud          |   285 |
| drew                   |   188 |
| laravel_cloud_personal |   118 |
| slack                  |    88 |
| notion                 |    57 |
| linear                 |    40 |
| atuin                  |    20 |
| toolbox_manage         |     9 |

## Display conventions

- `service action target · outcome`, using the same status, padding, background, truncation and expansion as ordinary tools.
- Public/private Slack scope and Cloud work/personal scope stay visible.
- Lists show returned items, not the advertised total across pages. Known pagination is labelled `more available`.
- Reads favour a returned title or issue identifier/status; content stays in expansion. Read-heavy tools can show Pi's estimated output tokens.
- Cloud updates show changed field names, never configuration values. Secret values, signed URL queries, environment-variable values and nested Toolbox arguments are excluded.
- Cloud settings changes say `deploy required`; queued deployments and asynchronous Notion tasks keep their actual state. The deletion helper says `confirmation required · not deleted`.
- Resource UUIDs are shown as an eight-character `#prefix`; full arguments remain available on expansion.
- Unsupported response shapes keep the fallback view; absent historical result counts remain unknown, not zero.
- Result titles and compact summaries use the existing hidden session metadata so new calls retain these details after reload. Old absent results cannot be reconstructed reliably.
- No MCP operations were executed to validate mutations. No tests were added; validation used type/lint checks, local argument replay and synthetic display previews.

## Coverage

| Tool                                                        | Calls |
| ----------------------------------------------------------- | ----: |
| `mcp__drew__get_content_tool`                               |   186 |
| `mcp__laravel_cloud__list_environments`                     |   109 |
| `mcp__slack__slack_search_public`                           |    60 |
| `mcp__linear__list_issues`                                  |    27 |
| `mcp__notion__notion_search`                                |    25 |
| `mcp__notion__notion_fetch`                                 |    24 |
| `mcp__laravel_cloud__list_applications`                     |    23 |
| `mcp__laravel_cloud__get_deployment`                        |    18 |
| `mcp__slack__slack_search_public_and_private`               |    16 |
| `mcp__laravel_cloud__stop_environment`                      |    14 |
| `mcp__laravel_cloud_personal__get_deployment`               |    13 |
| `mcp__linear__get_issue`                                    |    13 |
| `mcp__laravel_cloud_personal__verify_domain`                |    13 |
| `mcp__laravel_cloud__update_environment`                    |    13 |
| `mcp__laravel_cloud__list_organizations`                    |    11 |
| `mcp__atuin__atuin_history`                                 |    11 |
| `mcp__laravel_cloud__get_environment_logs`                  |    10 |
| `mcp__laravel_cloud_personal__update_environment`           |    10 |
| `mcp__laravel_cloud__update_instance`                       |    10 |
| `mcp__slack__slack_read_thread`                             |     9 |
| `mcp__laravel_cloud__get_skill`                             |     9 |
| `mcp__laravel_cloud_personal__list_applications`            |     9 |
| `mcp__laravel_cloud_personal__get_environment`              |     9 |
| `mcp__laravel_cloud__start_environment`                     |     9 |
| `mcp__laravel_cloud_personal__get_usage`                    |     8 |
| `mcp__laravel_cloud__create_application`                    |     7 |
| `mcp__laravel_cloud_personal__list_organizations`           |     7 |
| `mcp__toolbox_manage__discover`                             |     6 |
| `mcp__laravel_cloud__create_deployment`                     |     5 |
| `mcp__laravel_cloud_personal__list_environments`            |     5 |
| `mcp__laravel_cloud_personal__create_deployment`            |     5 |
| `mcp__atuin__atuin_threads_read`                            |     5 |
| `mcp__laravel_cloud__list_instances`                        |     5 |
| `mcp__notion__notion_update_page`                           |     5 |
| `mcp__laravel_cloud__get_command`                           |     4 |
| `mcp__laravel_cloud_personal__create_application`           |     4 |
| `mcp__laravel_cloud_personal__list_instances`               |     4 |
| `mcp__laravel_cloud_personal__update_instance`              |     4 |
| `mcp__laravel_cloud_personal__create_domain`                |     4 |
| `mcp__laravel_cloud__get_deployment_logs`                   |     4 |
| `mcp__laravel_cloud__list_database_types`                   |     4 |
| `mcp__laravel_cloud__run_command`                           |     3 |
| `mcp__laravel_cloud__list_regions`                          |     3 |
| `mcp__laravel_cloud__list_instance_sizes`                   |     3 |
| `mcp__toolbox_manage__call`                                 |     3 |
| `mcp__laravel_cloud_personal__list_deployments`             |     3 |
| `mcp__laravel_cloud_personal__get_deployment_logs`          |     3 |
| `mcp__laravel_cloud_personal__get_skill`                    |     3 |
| `mcp__laravel_cloud_personal__get_domain`                   |     3 |
| `mcp__slack__slack_read_file`                               |     3 |
| `mcp__laravel_cloud__list_source_control_accounts`          |     3 |
| `mcp__laravel_cloud__list_databases`                        |     3 |
| `mcp__laravel_cloud__list_deployments`                      |     2 |
| `mcp__laravel_cloud__attach_resource`                       |     2 |
| `mcp__laravel_cloud__get_environment`                       |     2 |
| `mcp__laravel_cloud_personal__list_instance_sizes`          |     2 |
| `mcp__laravel_cloud_personal__delete_application`           |     2 |
| `mcp__laravel_cloud_personal__update_application`           |     2 |
| `mcp__notion__notion_get_tool_access`                       |     2 |
| `mcp__atuin__atuin_threads_search`                          |     2 |
| `mcp__drew__search_content_tool`                            |     2 |
| `mcp__laravel_cloud__list_database_schemas`                 |     2 |
| `mcp__laravel_cloud__get_usage`                             |     2 |
| `mcp__laravel_cloud__create_bucket`                         |     1 |
| `mcp__laravel_cloud__create_bucket_key`                     |     1 |
| `mcp__laravel_cloud__list_buckets`                          |     1 |
| `mcp__laravel_cloud__get_environment_replicas`              |     1 |
| `mcp__laravel_cloud_personal__purge_edge_cache`             |     1 |
| `mcp__laravel_cloud_personal__list_regions`                 |     1 |
| `mcp__laravel_cloud_personal__list_source_control_accounts` |     1 |
| `mcp__laravel_cloud_personal__list_database_types`          |     1 |
| `mcp__laravel_cloud_personal__list_databases`               |     1 |
| `mcp__laravel_cloud__set_environment_variables`             |     1 |
| `mcp__notion__notion_create_pages`                          |     1 |
| `mcp__atuin__atuin_threads_list`                            |     1 |
| `mcp__atuin__atuin_output_search`                           |     1 |

## Examples

Illustrative values, not private history excerpts. Colours are omitted in this Markdown preview.

```text
✓ cloud environments app #12345678 · 2 environments
✓ cloud personal deployment #12345678 · deploying · main · a1b2c3d
✓ cloud update environment env #12345678 · branch, build command · configured · deploy required
✓ cloud personal verify domain app.example.com · DNS verified · SSL pending
✓ cloud personal delete application app #12345678 · confirmation required · not deleted
✓ cloud set variables env #12345678 · 2 variables · set · configured · deploy required
✓ slack search deploy after:2026-11-01 · 3 results
✓ slack search all deploy after:2026-11-01 · 3 results
✓ slack thread C12345 · 1790000000.000100 · 2 messages
✓ linear issues timeouts · team:Platform · 0 issues
✓ linear issue PLAT-42 Fix deployment timeouts · In Progress
✓ notion search runbook · 1 result
✓ notion read Deployment runbook · ~240 tokens · truncated
✓ notion create 1 page · async running
✓ drew search queue latency · plain_thread · hybrid · 2026-11-01 · 4 documents
✓ drew read 1 document · gong_call · doc #12345678 · ~240 tokens
✓ atuin history git rebase · workspace · failed only · 1 command
✓ toolbox validate library.install · valid · not executed
```
