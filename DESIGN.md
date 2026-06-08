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
