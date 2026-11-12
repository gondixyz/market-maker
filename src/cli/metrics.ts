import { metricsText } from '../engine/metrics';
import type { RoundReport } from '../engine/runner';

/**
 * Pushes every round's metrics to `url` once the round ends. Formatting and sending both run off
 * the round's call stack, and a push that fails either way is logged and dropped: metrics never
 * hold up or stop a round, and the next round pushes fresh values.
 *
 * IMPLEMENTATION NOTE: VictoriaMetrics takes Prometheus text exposition POSTed to
 * `/api/v1/import/prometheus`, stamping samples that carry no timestamp with the time they arrive,
 * and adds the labels of each `extra_label=name=value` query argument to every sample
 * (https://docs.victoriametrics.com/victoriametrics/#how-to-import-data-in-prometheus-exposition-format).
 * Behind a `-http.pathPrefix`, as gondi's stores run, the path takes that prefix too.
 */
export const pushMetricsEachRound = (
  runner: { on(event: 'round', listener: (report: RoundReport) => void): unknown },
  url: string,
) => {
  runner.on('round', (report) => {
    Promise.resolve()
      .then(() => fetch(url, { method: 'POST', body: metricsText(report) }))
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      })
      .catch((error: unknown) => console.warn(`warning: could not push metrics: ${String(error)}`));
  });
};
