// A custom full-screen TUI component that shows Snowflake SQL results as a
// scrollable table. Used by the `/snowflake-sql` and `/snowflake-results`
// commands via `ctx.ui.custom()`.
// @ts-nocheck
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SnowflakeColumn } from "./sql-api.ts";

const MIN_COL = 4;
const MAX_COL = 40;
const VISIBLE_ROWS = 24;

function cell(value: string | null): string {
  return value === null ? "NULL" : value;
}

export class SqlResultTable {
  private rowOffset = 0;
  private colOffset = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private colWidths: number[];

  constructor(
    private theme: any,
    private title: string,
    private columns: SnowflakeColumn[],
    private rows: (string | null)[][],
    private meta: { elapsedMs: number; numRows: number; truncated: boolean; connection: string },
    private onClose: () => void,
  ) {
    this.colWidths = columns.map((c, i) => {
      let w = c.name.length;
      for (let r = 0; r < Math.min(rows.length, 500); r++) {
        const len = cell(rows[r][i]).length;
        if (len > w) w = len;
      }
      return Math.min(Math.max(w, MIN_COL), MAX_COL);
    });
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  private visibleColumns(width: number): { start: number; end: number } {
    let used = 0;
    let end = this.colOffset;
    for (; end < this.columns.length; end++) {
      const w = this.colWidths[end] + 3; // " │ " separator
      if (used + w > width && end > this.colOffset) break;
      used += w;
    }
    return { start: this.colOffset, end: Math.max(end, this.colOffset + 1) };
  }

  private formatRow(values: string[], start: number, end: number, width: number): string {
    const parts: string[] = [];
    for (let i = start; i < end && i < values.length; i++) {
      const truncated = truncateToWidth(values[i], this.colWidths[i]);
      const pad = Math.max(0, this.colWidths[i] - visibleWidth(truncated));
      parts.push(truncated + " ".repeat(pad));
    }
    return truncateToWidth(parts.join(" │ "), width);
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const th = this.theme;
    const lines: string[] = [];

    const { start, end } = this.visibleColumns(width);
    const hiddenLeft = start > 0 ? "◀ " : "  ";
    const hiddenRight = end < this.columns.length ? " ▶" : "  ";

    lines.push(
      truncateToWidth(
        th.fg("accent", ` ${this.title} `) +
          th.fg("dim", `${this.meta.numRows} row(s) in ${this.meta.elapsedMs}ms via '${this.meta.connection}'`),
        width,
      ),
    );
    if (this.meta.truncated) {
      lines.push(truncateToWidth(th.fg("warning", `  showing first ${this.rows.length} of ${this.meta.numRows} rows`), width));
    }
    lines.push("");

    const header = this.formatRow(this.columns.map((c) => c.name), start, end, width - 4);
    lines.push(truncateToWidth(`${hiddenLeft}${th.style(header, { bold: true })}${hiddenRight}`, width));
    lines.push(truncateToWidth(th.fg("borderMuted", "─".repeat(Math.min(width, visibleWidth(header) + 4))), width));

    const visibleCount = Math.min(VISIBLE_ROWS, this.rows.length - this.rowOffset);
    for (let r = 0; r < visibleCount; r++) {
      const row = this.rows[this.rowOffset + r];
      const line = this.formatRow(row.map(cell), start, end, width - 4);
      lines.push(truncateToWidth(`  ${line}`, width));
    }
    if (this.rows.length === 0) {
      lines.push(truncateToWidth(`  ${th.fg("dim", "(no rows)")}`, width));
    }

    lines.push("");
    const pos = this.rows.length
      ? `rows ${this.rowOffset + 1}-${this.rowOffset + visibleCount} of ${this.rows.length}`
      : "0 rows";
    const cols = this.columns.length > 1 ? `  cols ${start + 1}-${end} of ${this.columns.length}` : "";
    lines.push(
      truncateToWidth(
        `  ${th.fg("dim", `${pos}${cols}  •  ↑↓ scroll  ←→ columns  PgUp/PgDn page  Home/End  q/esc close`)}`,
        width,
      ),
    );

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  handleInput(data: string): boolean {
    const maxOffset = Math.max(0, this.rows.length - VISIBLE_ROWS);
    if (matchesKey(data, "up")) this.rowOffset = Math.max(0, this.rowOffset - 1);
    else if (matchesKey(data, "down")) this.rowOffset = Math.min(maxOffset, this.rowOffset + 1);
    else if (matchesKey(data, "pageUp")) this.rowOffset = Math.max(0, this.rowOffset - VISIBLE_ROWS);
    else if (matchesKey(data, "pageDown")) this.rowOffset = Math.min(maxOffset, this.rowOffset + VISIBLE_ROWS);
    else if (matchesKey(data, "home")) this.rowOffset = 0;
    else if (matchesKey(data, "end")) this.rowOffset = maxOffset;
    else if (matchesKey(data, "left")) this.colOffset = Math.max(0, this.colOffset - 1);
    else if (matchesKey(data, "right")) this.colOffset = Math.min(Math.max(0, this.columns.length - 1), this.colOffset + 1);
    else if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
      this.onClose();
      return true;
    } else {
      return false;
    }
    this.invalidate();
    return true;
  }
}

const TEXT_POPUP_VISIBLE_ROWS = 20;

/** A small scrollable read-only text panel, used for the connection-details popup. */
export class TextPopup {
  private offset = 0;

  constructor(
    private theme: any,
    private title: string,
    private lines: string[],
    private onClose: () => void,
  ) {}

  render(width: number): string[] {
    const th = this.theme;
    // Draw a 4-edge box using the same "border" token the editor's own
    // top/bottom rule uses, so the popup reads as part of the same UI family.
    const border = (text: string) => th.fg("border", text);
    const innerWidth = Math.max(1, width - 4); // "│ " + content + " │"

    const wrapLine = (content: string): string => {
      const truncated = truncateToWidth(content, innerWidth);
      const pad = Math.max(0, innerWidth - visibleWidth(truncated));
      return border("│ ") + truncated + " ".repeat(pad) + border(" │");
    };

    const out: string[] = [];
    out.push(border(`╭${"─".repeat(Math.max(0, width - 2))}╮`));
    out.push(wrapLine(th.style(` ${this.title} `, { bold: true, fg: "accent" })));
    out.push(wrapLine(th.fg("borderMuted", "─".repeat(Math.min(innerWidth, visibleWidth(this.title) + 4)))));

    const visible = this.lines.slice(this.offset, this.offset + TEXT_POPUP_VISIBLE_ROWS);
    for (const line of visible) out.push(wrapLine(line));

    out.push(wrapLine(""));
    const hint =
      this.lines.length > TEXT_POPUP_VISIBLE_ROWS
        ? `${this.offset + 1}-${Math.min(this.offset + TEXT_POPUP_VISIBLE_ROWS, this.lines.length)} of ${this.lines.length}  ↑↓ scroll  q/esc close`
        : "q/esc close";
    out.push(wrapLine(th.fg("dim", hint)));
    out.push(border(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
    return out;
  }

  handleInput(data: string): boolean {
    const maxOffset = Math.max(0, this.lines.length - TEXT_POPUP_VISIBLE_ROWS);
    if (matchesKey(data, "up")) this.offset = Math.max(0, this.offset - 1);
    else if (matchesKey(data, "down")) this.offset = Math.min(maxOffset, this.offset + 1);
    else if (matchesKey(data, "pageUp")) this.offset = Math.max(0, this.offset - TEXT_POPUP_VISIBLE_ROWS);
    else if (matchesKey(data, "pageDown")) this.offset = Math.min(maxOffset, this.offset + TEXT_POPUP_VISIBLE_ROWS);
    else if (matchesKey(data, "home")) this.offset = 0;
    else if (matchesKey(data, "end")) this.offset = maxOffset;
    else if (
      matchesKey(data, "escape") ||
      matchesKey(data, "q") ||
      matchesKey(data, "enter") ||
      matchesKey(data, "ctrl+c")
    ) {
      this.onClose();
      return true;
    } else {
      return false;
    }
    return true;
  }

  invalidate(): void {}
}

/**
 * Show a small centered popup with scrollable text lines (e.g. connection
 * details), and wait until the user closes it. `buildLines` receives the
 * active theme so callers can apply styling.
 */
export async function showTextPopup(
  ctx: ExtensionContext,
  title: string,
  buildLines: (theme: any) => string[],
): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      const popup = new TextPopup(theme, title, buildLines(theme), () => done());
      return {
        render: (width: number) => popup.render(width),
        handleInput: (data: string) => {
          if (popup.handleInput(data)) tui.requestRender();
        },
        invalidate: () => popup.invalidate(),
      };
    },
    { overlay: true, overlayOptions: { width: "70%", maxHeight: "70%", anchor: "center" } },
  );
}

/** Open a full-screen scrollable table for one query result and wait until the user closes it. */
export async function showSqlResultTable(
  ctx: ExtensionContext,
  title: string,
  columns: SnowflakeColumn[],
  rows: (string | null)[][],
  meta: { elapsedMs: number; numRows: number; truncated: boolean; connection: string },
): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const table = new SqlResultTable(theme, title, columns, rows, meta, () => done());
    return {
      render: (width: number) => table.render(width),
      handleInput: (data: string) => {
        if (table.handleInput(data)) tui.requestRender();
      },
      invalidate: () => table.invalidate(),
    };
  });
}
