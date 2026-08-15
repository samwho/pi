# Source index and version boundaries

This skill is a practical distillation, not a replacement for the runtime or
its user files. Talon and Community evolve quickly. If installed behavior,
source code, and this reference disagree, inspect the installed user files,
Talon log, and shipped `.pyi` stubs first; then consult the live pages below.
Ask for the Talon version before relying on beta or version-specific behavior.

## Reviewed primary sources

- [Official Talon documentation](https://talonvoice.com/docs/) — historical
  Talon 0.4.0 documentation containing the introduction, getting started
  guidance, `.talon` overview, and API reference for `Context`, `Module`, `app`,
  `clip`, `fs`, and `noise`. See the [changelog](https://talonvoice.com/dl/latest/changelog.html)
  for release notes.
- [Talon Community Wiki](https://talon.wiki/) — community-maintained guidance
  covering installation, basic use, grammar, the framework, voice coding,
  integrations, hardware, speech engines, and troubleshooting.
- [Talon Community user file set](https://github.com/talonhub/community) — the
  practical source of available Community commands, action names, lists, tags,
  snippets, app integrations, tests, and current conventions.

On 2026-08-15, `https://talon.wiki/sitemap.xml` listed 53 URLs. Treat this
as a navigation snapshot, not a guarantee that every page remains current.
The [Wiki repository](https://github.com/TalonCommunity/Wiki) was used to read
repository Markdown where practical, without copying the site shell into this
skill.

The sitemap also contains dynamic [Repository Explorer](https://talon.wiki/explorer)
and [documentation search](https://talon.wiki/search) pages. Treat these as
navigation/search utilities, not authoritative static technical sources. The
old [unofficial API page](https://talon.wiki/unofficial_talon_docs) says its
content moved into the Customization sections.

## Topic map

| Task | Start here |
| --- | --- |
| Install Talon/Community | [installation guide](https://talon.wiki/Resource%20Hub/Talon%20Installation/installation_guide), [Community download](https://talon.wiki/Resource%20Hub/Talon%20Installation/downloading-community) |
| Learn everyday commands | [basic usage](https://talon.wiki/Basic%20Usage/basic_usage), [dictating prose](https://talon.wiki/Basic%20Usage/prose_captures) |
| Write `.talon` grammar | [`.talon` files](https://talon.wiki/Customization/talon-files), [`.talon-list`](https://talon.wiki/Customization/talon_lists), [key action](https://talon.wiki/Customization/Talon%20Library%20Reference/key_action) |
| Use the Python framework | [framework overview](https://talon.wiki/Customization/Talon%20Framework/talon-framework-overview), [Modules/Contexts](https://talon.wiki/Customization/Talon%20Framework/modules_and_contexts), [Actions](https://talon.wiki/Customization/Talon%20Framework/actions), [Captures](https://talon.wiki/Customization/Talon%20Framework/captures), [Lists](https://talon.wiki/Customization/Talon%20Framework/lists) |
| Context-sensitive behavior | [Apps](https://talon.wiki/Customization/Talon%20Framework/apps), [Tags](https://talon.wiki/Customization/Talon%20Framework/tags), [Modes](https://talon.wiki/Customization/Talon%20Framework/modes), [Scopes](https://talon.wiki/Customization/Talon%20Framework/scopes), [Settings](https://talon.wiki/Customization/Talon%20Framework/settings) |
| Debug runtime behavior | [tips and tricks](https://talon.wiki/Customization/misc-tips), [troubleshooting](https://talon.wiki/Resource%20Hub/Speech%20Recognition/troubleshooting), [recognition accuracy](https://talon.wiki/Resource%20Hub/Speech%20Recognition/improving_recognition_accuracy) |
| Voice coding | [overview](https://talon.wiki/Voice%20Coding/voice-coding-overview), [formatters](https://talon.wiki/Voice%20Coding/formatters), [operators](https://talon.wiki/Voice%20Coding/operators), [snippets](https://talon.wiki/Voice%20Coding/snippets), [symbols](https://talon.wiki/Voice%20Coding/symbols), [language-specific](https://talon.wiki/Voice%20Coding/language-specific) |
| Hardware/accessibility/integrations | [hardware](https://talon.wiki/Resource%20Hub/Hardware/), [speech engines](https://talon.wiki/Resource%20Hub/Speech%20Recognition/speech%20engines), [accessibility](https://talon.wiki/Integrations/accessibility), [essential integrations](https://talon.wiki/Integrations/essential-tools) |

## Agent Skills design sources

The skill structure follows the [Agent Skills specification](https://agentskills.io/specification),
particularly its required frontmatter, progressive disclosure, relative file
references, and recommended `SKILL.md` size. The activation description and
lean reference layout follow [best practices for skill creators](https://agentskills.io/skill-creation/best-practices)
and [description optimization](https://agentskills.io/skill-creation/optimizing-descriptions).
For future refinement, use the [evaluation guide](https://agentskills.io/skill-creation/evaluating-skills)
to compare realistic Talon tasks with and without the skill. For mutable Wiki
and Community sources, record review dates or commits when practical; direct
users to the installed Talon build, fileset, log, and shipped stubs as the
final authority.
