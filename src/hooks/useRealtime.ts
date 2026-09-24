import { REALTIME_SSE_PATH } from "@invai/contracts";
import { useEffect } from "react";
import { currentToken, useApp } from "../app/store";
import { API_URL } from "../lib/config";
import { connectSse } from "../realtime/sse";
import { invalidateQueues } from "./useStationQueue";

const QUEUE_EVENTS = new Set([
  "queue.changed",
  "item.state_changed",
  "bin.changed",
  "sheet.status_changed",
  "order.updated",
  "shipment.updated",
]);

/** Live queue updates over SSE while someone is signed in (the demo backend has none). */
export function useRealtime() {
  const token = useApp((s) => s.session?.sessionToken ?? null);
  const demo = useApp((s) => s.api.kind === "demo");

  useEffect(() => {
    if (!token || demo) {
      useApp.setState({ live: "off" });
      return;
    }
    return connectSse({
      url: `${API_URL}${REALTIME_SSE_PATH}`,
      token: currentToken,
      onStatus: (live) => useApp.setState({ live }),
      onReconnect: invalidateQueues,
      onMessage: (m) => {
        if (QUEUE_EVENTS.has(m.event)) invalidateQueues();
      },
    });
  }, [token, demo]);
}
