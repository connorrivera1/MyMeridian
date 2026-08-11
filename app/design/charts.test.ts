import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CapacityChart, TimeSeriesChart } from "~/design/charts";

describe("chart calendar labels", () => {
  it("renders time-series instants in the merchant timezone", () => {
    const html = renderToStaticMarkup(
      createElement(TimeSeriesChart, {
        data: [
          {
            date: new Date("2026-08-11T03:30:00.000Z"),
            values: { profit: 1 },
          },
        ],
        series: [
          {
            key: "profit",
            label: "Profit",
            color: "#fff",
          },
        ],
        timeZone: "America/Los_Angeles",
      }),
    );

    expect(html).toContain("Aug 10");
    expect(html).not.toContain("Aug 11");
  });

  it("does not shift stored capacity calendar keys into the viewer timezone", () => {
    const html = renderToStaticMarkup(
      createElement(CapacityChart, {
        history: [
          {
            date: new Date("2026-08-10T00:00:00.000Z"),
            received: 1,
            fulfilled: 1,
            backlog: 0,
          },
        ],
        forecast: [],
        capacity: 1,
      }),
    );

    expect(html).toContain("Aug 10");
    expect(html).not.toContain("Aug 9");
    expect(html).not.toContain("NaN");
  });
});
