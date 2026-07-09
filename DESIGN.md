# Design System & Visual Identity

## Typography
The UI utilizes two primary Google Fonts:
- **Display Typeface**: `Outfit` (used for headers h1-h6, providing a modern, geometric feel).
- **Sans/Body Typeface**: `Inter` (used for standard body text, buttons, and tabular data for maximum legibility).

## Color Palette (Dark Mode Native)
The application natively operates in a rich, low-light aesthetic using HSL variables.

### Backgrounds
- `--bg-base: hsl(222, 47%, 11%)`: Deep space blue for the main app background.
- `--bg-surface: hsl(217, 33%, 17%)`: Elevated elements like sidebars and cards.
- `--bg-surface-hover: hsl(217, 33%, 22%)`: Interactive hover states.

### Accents & Semantic Colors
- `--primary: hsl(252, 87%, 67%)`: Vibrant purple for active states, primary buttons, and highlight metrics.
- `--secondary: hsl(199, 89%, 48%)`: Bright cyan used in gradients alongside the primary.
- `--success: hsl(142, 71%, 45%)`: Deep green for positive PnL, "Funded" badges, and met targets.
- `--danger: hsl(348, 83%, 47%)`: Bold red for negative PnL and warnings.

### Text Hierarchy
- `--text-main: hsl(210, 40%, 98%)`: Bright white/blue for primary legibility.
- `--text-muted: hsl(215, 20%, 65%)`: Desaturated blue-gray for secondary text and table headers.

## Spacing & Component Patterns
- **Radius**: Heavy rounding on major components (`--radius-md: 12px` for cards, `--radius-lg: 20px` for dropzones).
- **Cards**: The primary container pattern (`.card`). Features subtle borders (`--border: hsl(217, 33%, 25%)`) and mild shadow. On hover, cards exhibit a `translateY(-2px)` micro-animation and increased shadow.
- **Badges**: Pill-shaped uppercase indicators (`.badge`) used globally to denote Account Buckets (Evaluation/Funded) and Status.
- **Inputs**: Solid filled inputs transitioning to bordered outlines with primary shadow glows on focus.

## Layout Shape
The application employs a fixed lateral sidebar (Width: 72) for Client Context, with the main content area functioning as a vertically scrolling canvas. The Dashboard prioritizes high-level aggregate metrics at the top (Card Grids & Recharts), naturally filtering down into highly detailed, data-dense tabular trees at the bottom.

## shadcn/ui Adoption

The app may use shadcn/ui as the component baseline while preserving the CAM CRM identity above. The adoption should be incremental and presentation-first so the existing workflow, Supabase persistence, tab state, and user permissions remain unchanged.

### Adoption Rules
- Keep the existing data flow, event handlers, Supabase calls, routing, auth behavior, and tab behavior unchanged unless a bug fix is explicitly required.
- Use shadcn/ui for presentational consistency: buttons, cards, tabs, tables, alerts, forms, dialogs, switches, checkboxes, textareas, badges, dropdowns, and tooltips.
- Map shadcn CSS variables to the existing dark workspace identity from this document instead of adopting a generic light theme.
- Prefer `lucide-react` icons in all interactive controls. Do not use emoji as product UI icons.
- Keep operational screens data-dense, scannable, and work-focused. Avoid marketing-style hero sections, oversized copy, and decorative-only UI.
- Refactor one surface at a time, then QA that section before moving to the next one.

### Token Mapping Direction
- `--background` should align with the existing deep base background.
- `--card` and `--popover` should align with elevated dark surfaces.
- `--primary` should carry the existing purple accent for primary actions and selected states.
- `--secondary` and `--accent` should support cyan/blue secondary emphasis without dominating the screen.
- `--destructive` should match the existing danger red.
- `--muted` and `--muted-foreground` should preserve readable subdued text for dense tables and metadata.

### First Refactor Targets
1. Manager Operations header, metric cards, and alert banner.
2. Users & Access table and user form controls.
3. Client roster table and assignment controls.
4. CAM workspace header, primary action row, and tab navigation.
5. Credentials/Profile forms and repeated credential panels.
