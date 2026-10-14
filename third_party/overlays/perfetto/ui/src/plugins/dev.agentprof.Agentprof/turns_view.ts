// SPDX-License-Identifier: Apache-2.0

import m from "mithril";
import {Button, ButtonVariant} from "../../widgets/button";
import type {Trace} from "../../public/trace";
import type {SqlValue} from "../../trace_processor/query_result";
import type {OverviewLoader} from "./overview_loader";
import {navigate} from "./navigation";
import {toolDescription} from "./tool_description";
import {modelDisplayName} from "./model_display";
import {intervalPosition, nanoseconds, turnDuration} from "./turns_timeline";
import "./turns_view.scss";

type Row = Record<string, SqlValue>;
interface Attrs {
  trace: Trace;
  rows: Row[];
  loader: OverviewLoader<Row>;
  clockAligned: boolean;
}
const text = (value: SqlValue | undefined) =>
  value === null || value === undefined ? "" : String(value);
const number = (value: SqlValue | undefined) => Number(value ?? 0);

export class TurnsView implements m.ClassComponent<Attrs> {
  private readonly expanded = new Set<number>();

  private select(trace: Trace, id: number) {
    navigate(trace, "/viewer");
    trace.selection.selectSqlEvent("slice", id, {scrollToSelection: true});
  }

  private bar(
    start: bigint,
    end: bigint,
    origin: bigint,
    limit: bigint,
    kind: string,
    label: string,
    incomplete: boolean,
  ) {
    const position = intervalPosition(start, end, origin, limit);
    return m(
      ".ap-turn-track",
      {"role": "img", "aria-label": label, "title": label},
      m(".ap-turn-interval", {
        className: `ap-turn-interval--${kind}${position.point ? " ap-turn-interval--point" : ""}${incomplete ? " ap-turn-interval--incomplete" : ""}`,
        style: {left: `${position.left}%`, width: `${position.width}%`},
      }),
    );
  }

  private events(row: Row, {trace, loader, clockAligned}: Attrs) {
    const id = number(row.prompt_id);
    const state = loader.turnDetails.get(id);
    if (state?.error) {
      return m(
        ".ap-turn-error",
        {role: "alert"},
        "Could not read this turn. ",
        m(Button, {label: "Retry turn", onclick: () => loader.retryTurn(id)}),
      );
    }
    if (!state?.rows) {
      return m("p.ap-muted", {role: "status"}, "Reading turn activity…");
    }
    const origin = nanoseconds(row.start_ts) ?? 0n;
    const limit = nanoseconds(row.display_end_ts) ?? origin;
    const incomplete = number(row.incomplete) !== 0;
    const eventRows = state.rows.map((event) => {
      const kind = text(event.kind);
      const model = kind === "assistant-message";
      const tool = kind === "tool-execution";
      const duration = nanoseconds(event.measured_ns);
      const label = model
        ? "Model response"
        : kind === "provider-request"
          ? "Provider request"
          : kind === "model-call"
            ? `Model task ${text(event.name)}`
            : text(event.name) || kind;
      let description = "";
      if (tool || kind === "script") {
        try {
          description =
            toolDescription(
              text(event.intent) || undefined,
              text(event.arguments) || undefined,
              kind === "script"
                ? {
                    language: text(event.language) || undefined,
                    lineCount:
                      event.line_count === null
                        ? undefined
                        : number(event.line_count),
                    truncated: number(event.args_truncated) !== 0,
                  }
                : undefined,
            ) || "";
        } catch {
          description = "Recorded arguments could not be read";
        }
      }
      if (model) {
        description = [
          event.first_content_ms !== null &&
          event.first_content_ms !== undefined
            ? `first content ${number(event.first_content_ms).toFixed(1)} ms`
            : "",
          event.output_tokens !== null && event.output_tokens !== undefined
            ? `${text(event.output_tokens)} output tokens`
            : "",
        ]
          .filter(Boolean)
          .join(" · ");
      }
      const start = nanoseconds(event.start_ts) ?? origin;
      const end = nanoseconds(event.observed_end_ts) ?? start;
      const missing = number(event.incomplete) !== 0 || duration === undefined;
      const color = model ? "model" : tool ? "tool" : "other";
      return m(
        ".ap-turn-event",
        {key: number(event.id)},
        m(
          ".ap-turn-event-label",
          {
            className:
              number(event.depth) > 0
                ? "ap-turn-event-label--nested"
                : undefined,
          },
          m(Button, {
            label,
            className: "ap-turn-event-link",
            variant: ButtonVariant.Minimal,
            icon: model ? "smart_toy" : tool ? "build" : "timeline",
            onclick: () => this.select(trace, number(event.id)),
          }),
          description &&
            m(
              "span.ap-turn-description",
              {title: description},
              description.replace(/\s+/g, " ").slice(0, 240),
            ),
          number(event.is_error) !== 0 && m("span.ap-turn-badge", "Error"),
          text(event.child_session).length > 0 &&
            m(
              "span.ap-turn-description",
              `Child session: ${text(event.child_session)}`,
            ),
          event.child_prompt_id !== null &&
            event.child_prompt_id !== undefined &&
            m(Button, {
              label: "Open child session",
              variant: ButtonVariant.Minimal,
              onclick: () => this.select(trace, number(event.child_prompt_id)),
            }),
        ),
        clockAligned
          ? this.bar(
              start,
              end,
              origin,
              limit,
              color,
              `${label}: ${missing ? "incomplete or unknown duration" : turnDuration(duration)}`,
              missing,
            )
          : m("span.ap-muted", "Position unavailable"),
        m(
          "span.ap-turn-event-duration",
          missing ? "Incomplete / unknown" : turnDuration(duration),
        ),
      );
    });
    return m(
      ".ap-turn-details",
      !clockAligned &&
        m(
          "p.ap-muted",
          "Clock conversion errors were reported; proportional positions are unavailable.",
        ),
      incomplete &&
        m(
          "p.ap-muted",
          "Incomplete interaction. This view shows retained work, not a measured completion time.",
        ),
      m(
        ".ap-turn-axis",
        m("span", "0"),
        m("span", turnDuration(limit - origin)),
      ),
      m(
        ".ap-turn-event.ap-turn-run",
        m(Button, {
          label: incomplete ? "Observed run" : "Run",
          variant: ButtonVariant.Minimal,
          onclick: () => this.select(trace, id),
        }),
        clockAligned &&
          this.bar(
            origin,
            limit,
            origin,
            limit,
            "other",
            "Recorded interaction extent",
            incomplete,
          ),
        m("span.ap-turn-event-duration", turnDuration(limit - origin)),
      ),
      eventRows,
      eventRows.length === 0 &&
        m(
          "p.ap-muted",
          "No model or tool work was retained for this interaction.",
        ),
      number(state.rows[0]?.total_events) > state.rows.length &&
        m(
          "p.ap-muted",
          `Showing ${state.rows.length} of ${text(state.rows[0]?.total_events)} operations. Open the full timeline for the rest.`,
        ),
      m(Button, {
        label: "Open turn in timeline",
        icon: "timeline",
        onclick: () => this.select(trace, id),
      }),
    );
  }

  view({attrs}: m.CVnode<Attrs>) {
    const {rows, loader, clockAligned} = attrs;
    return m(
      ".ap-turns",
      {
        onkeydown: (event: KeyboardEvent) => {
          if (
            event.target instanceof HTMLButtonElement &&
            (event.key === "Enter" || event.key === " ")
          ) {
            event.stopPropagation();
          }
        },
      },
      rows.map((row) => {
        const id = number(row.prompt_id);
        const open = this.expanded.has(id);
        const toggle = () => {
          if (this.expanded.has(id)) this.expanded.delete(id);
          else {
            this.expanded.add(id);
            loader.openTurn(id);
          }
        };
        const session = text(row.session);
        const sessionLabel = session.replace(
          /^([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
          "$1",
        );
        const origin = nanoseconds(row.start_ts) ?? 0n;
        const end = nanoseconds(row.display_end_ts) ?? origin;
        const identities: { provider: SqlValue; model: SqlValue }[] =
          JSON.parse(text(row.model_identities) || "[]");
        const modelTitle = identities
          .map((identity) =>
            [
              text(identity.model) || "Model not recorded",
              text(identity.provider),
            ]
              .filter(Boolean)
              .join(" · "),
          )
          .join(" / ");
        const modelLabel = identities
          .map((identity) =>
            [
              modelDisplayName(text(identity.model) || "Model not recorded"),
              text(identity.provider),
            ]
              .filter(Boolean)
              .join(" · "),
          )
          .join(" / ");
        const parts = [
          ["models_only_ns", "Model", "model"],
          ["tools_only_ns", "Tools", "tool"],
          ["overlap_ns", "Overlap", "overlap"],
          ["unattributed_ns", "Unattributed", "gap"],
        ] as const;
        return m(
          "article.ap-turn",
          {key: id},
          m(
            ".ap-turn-summary",
            {onclick: toggle},
            m(
              "header.ap-turn-header",
              m("strong.ap-turn-number", `Turn ${text(row.turn_number)}`),
              m(
                "span.ap-turn-session",
                {title: `Session ${session}`},
                `Session ${sessionLabel}`,
              ),
              m(
                "span.ap-muted",
                {title: "Offset from capture start"},
                `+${turnDuration(origin - (nanoseconds(row.capture_start_ts) ?? origin))}`,
              ),
              modelLabel &&
                m("span.ap-turn-models", {title: modelTitle}, modelLabel),
              m(
                "strong.ap-turn-duration",
                number(row.incomplete) && end <= origin
                  ? "Incomplete · duration unknown"
                  : `${number(row.incomplete) ? "Incomplete · observed " : ""}${turnDuration(end - origin)}`,
              ),
              m(Button, {
                "icon": open ? "expand_less" : "expand_more",
                "variant": ButtonVariant.Minimal,
                "compact": true,
                "className": "ap-turn-toggle",
                "title": open ? "Hide turn details" : "Show turn details",
                "aria-label": `${open ? "Collapse" : "Expand"} turn ${text(row.turn_number)} in ${text(row.session)}`,
                "aria-expanded": String(open),
                "aria-controls": `ap-turn-${id}`,
                "onclick": (event: MouseEvent) => {
                  event.stopPropagation();
                  toggle();
                },
              }),
            ),
            m(
              "p.ap-turn-prompt",
              {title: text(row.prompt_text)},
              text(row.prompt_text).trim() || "Prompt text not recorded",
            ),
            clockAligned &&
              m(
                ".ap-turn-activity",
                {
                  "role": "img",
                  "aria-label":
                    "Measured model/tool occupancy; unclassified gaps are not assumed waiting",
                },
                parts.map(([key, label, color]) => {
                  const duration = nanoseconds(row[key]) ?? 0n;
                  const position = intervalPosition(
                    origin,
                    origin + duration,
                    origin,
                    end,
                  );
                  return m("span", {
                    className: `ap-turn-activity--${color}`,
                    style: {width: `${position.width}%`},
                    title: `${label}: ${turnDuration(duration)}`,
                  });
                }),
              ),
            m(
              ".ap-turn-legend",
              parts.map(([key, label, color]) =>
                m(
                  "span",
                  m("i", {className: `ap-turn-dot--${color}`}),
                  `${label} ${turnDuration(row[key])}`,
                ),
              ),
              m(
                "span",
                `${number(row.model_calls)} responses · ${number(row.tools)} tools`,
              ),
              number(row.unmatched_requests) > 0 &&
                m(
                  "span",
                  `${number(row.unmatched_requests)} unmatched requests`,
                ),
            ),
            (number(row.unknown_models) > 0 || number(row.unknown_tools) > 0) &&
              m(
                "p.ap-muted",
                "Some durations are unknown; activity totals include measured work only.",
              ),
          ),
          open &&
            m(
              "div.ap-turn-body",
              {id: `ap-turn-${id}`},
              this.events(row, attrs),
            ),
        );
      }),
      loader.turnPageError &&
        m(
          "p.ap-turn-error",
          {role: "alert"},
          "Could not load more turns. Try again.",
        ),
      number(rows[0]?.total_turns) > rows.length &&
        m(Button, {
          label: loader.loadingMoreTurns
            ? "Reading more turns…"
            : "Load more turns",
          disabled: loader.loadingMoreTurns,
          onclick: () => loader.moreTurns(),
        }),
    );
  }
}
