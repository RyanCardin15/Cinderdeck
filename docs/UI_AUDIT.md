# Cinderdeck UI audit

Audit and implementation: September 28, 2026.

## Direction

Use the Lane map as the visual reference across the application: clear hierarchy,
quiet charcoal surfaces, fine outlines, and restrained ember accents. Keep native
macOS controls and specialized editing canvases where they help the task.

The main inconsistency was accumulated local styling: glass capsules, unrelated
button treatments, oversized headings, faint metadata, and different empty states.
The new shared `DeckStyle` components give those surfaces a common foundation.

## Coverage and changes

| Area | Result | Verification |
| --- | --- | --- |
| Workspaces | Compact title and path hierarchy, icon navigation, consistent sidebar/search, clear selection, no-results recovery, task/workflow cards, tighter run inspector | Live dark and light walkthrough; successful fixture task and output; navigation and runner tests |
| Stacks and Lane map | Shared card and control treatment; semantic runtime colors; clearer small icons and headings; retained graph layout and interactions | Live graph selection and connections; lane graph tests |
| Workspace creation, component editing, agents and lanes | Consistent sheet headers, persistent field labels, primary actions, named reorder/remove controls | Live new-task sheet; source review and build for the other sheets; workspace navigation tests |
| Pull requests | Shared window chrome, repository search, balanced sidebar width, readable inspector sections and diff text | Live authenticated repository/PR list and PR overview; read-only interaction |
| History, favorites and clipboard text | Shared search and empty states, selection toolbar, restrained filter controls | Live history navigation/empty states; history layout tests |
| Preferences | Consistent icon tiles, row spacing and description wrapping; 49 formerly unnamed switches use their actual setting titles | All twelve categories inspected live; General labels rechecked in the accessibility tree; preferences tests |
| Annotate | Refined drop zone, shared sidebar headings and primary action, larger toolbar targets, named presets/colors/alignment/sliders, selected states | Live empty editor and expanded sidebar in light/dark; palette, preset and viewport tests |
| Video editor | Matching drop zone and primary action; shared sidebar headings; named palette and numeric controls | Live light empty editor; sidebar source review; export-settings tests |
| Capture, recording and repro | Matching record/stop controls and scrolling-capture actions; consistent repro panel; named repro buttons; reduced-motion recording indicator | Recording-toolbar source review and shortcut tests; capture/repro completion flows not recorded in this audit |
| Quick Access | Named actions and reduced-motion hover behavior through the shared icon control | Source review and build |
| Onboarding and splash | More legible supporting text; reduced-motion splash entrance; preserved interactive demo | Onboarding capture/recording steps inspected live; splash source review |
| Shortcut overlay and upload history | Shared surfaces, search/actions and close-control labeling | Source review and successful debug preview launch; panel contents not fully exercised |
| Updates and crash reporting | Kept native updater/menu and AppKit alert presentation; existing semantic macOS colors already fit the utility context | Source review; update availability state inspected in Preferences |

## Shared design rules

- `DeckStyle` owns adaptive canvas, sidebar, surface, inset, accent and status colors.
- Use 23-point window titles, 15-point section titles, 13-point body text,
  11-point supporting text and 10-point monospaced section labels.
- Use 12-point card corners and 8-point control corners. Reserve shadows for
  floating overlays; ordinary content cards use a fine outline.
- Use `DeckSurface`, `DeckButtonStyle`, `DeckSearchField`, `DeckSheetHeader` and
  `DeckEmptyState` for new application chrome. Preserve specialized canvas controls.
- Communicate state with text/icons as well as color. Name icon-only controls and
  expose selected states. Respect Reduce Motion for new hover/entrance effects.
- Native settings, menus, pickers, alerts and permission prompts retain native behavior.

## Validation

- Debug build succeeded on macOS 26.3 with local ad-hoc signing.
- 69 existing tests passed for workspace navigation, Lane map, recording selection,
  runner execution, history layout, preferences and recording shortcuts.
- 67 additional existing tests passed for annotation palettes, canvas presets,
  viewport state and video export settings. Total: **136 passed, zero failures**.
- `git diff --check` passed.
- Calculated contrast for the four semantic foreground colors against the shared
  opaque card surface ranges from **5.34:1 to 8.35:1** across light/dark palettes.
  Prominent controls use a solid card base and restrained tint, including hover and
  pressed states. This is a token check, not a whole-app accessibility certification.
- Native UI inspection caught and corrected inherited accessibility labels on
  Preferences appearance buttons, unnamed editor controls, a singular workspace
  count, and excessive PR sidebar width.

Local evidence is under `.build/`: `ui-final-build.log`, `ui-verification.xcresult`,
`ui-editor-verification.xcresult`, and isolated fixtures in `ui-audit/`. These are
development artifacts and are not committed.

## Limits of this pass

The walkthrough covers representative live screens and the full feature inventory,
not every content, error, localization or window-size permutation. Real recording,
camera/microphone access, document export, cloud upload, GitHub review submission,
destructive actions, updater installation and crash-report transmission were not
performed. Rendering changes compile; the tests above cover the related existing
behavior. Full VoiceOver traversal and OS-level Increase Contrast/Reduce Motion
walkthroughs remain separate validation work.

The changes live in an isolated worktree on `codex/ui-quality`. The installed
release and the original checkout's existing performance work were preserved.
