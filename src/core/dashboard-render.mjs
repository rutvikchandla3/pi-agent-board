/**
 * Request a differential dashboard repaint.
 *
 * Full-screen custom overlays still participate in Pi TUI's line diffing. Passing
 * `true` here discards that state and clears the terminal before every repaint,
 * which is visible as flicker on terminals without synchronized-output support.
 */
export function requestDashboardRender(tui) {
	tui.requestRender();
}
