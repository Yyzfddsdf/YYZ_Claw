import { useEffect, useMemo, useState } from "react";

import farmBackgroundUrl from "./assets/farm-background.png";
import workerBerryLeftUrl from "./assets/cozy-worker-berry-left.gif";
import workerBerryRightUrl from "./assets/cozy-worker-berry-right.gif";
import workerBlueLeftUrl from "./assets/cozy-worker-blue-left.gif";
import workerBlueRightUrl from "./assets/cozy-worker-blue-right.gif";
import workerGoldLeftUrl from "./assets/cozy-worker-gold-left.gif";
import workerGoldRightUrl from "./assets/cozy-worker-gold-right.gif";
import workerGreenLeftUrl from "./assets/cozy-worker-green-left.gif";
import workerGreenRightUrl from "./assets/cozy-worker-green-right.gif";
import workerMintLeftUrl from "./assets/cozy-worker-mint-left.gif";
import workerMintRightUrl from "./assets/cozy-worker-mint-right.gif";
import workerVioletLeftUrl from "./assets/cozy-worker-violet-left.gif";
import workerVioletRightUrl from "./assets/cozy-worker-violet-right.gif";
import witchNeswUrl from "./assets/witch-001-NESW.png";
import witchSwenUrl from "./assets/witch-001-SWEN.png";
import "./active-scene.css";

const EXIT_MS = 1400;
const DOOR_POINT = { x: 39, y: 42 };
const WORK_STATIONS = [
  { x: 74, y: 55, dx: 2.2, dy: 1.2, work: "water", label: "浇水" },
  { x: 78, y: 69, dx: -2.4, dy: 1.4, work: "hoe", label: "锄地" },
  { x: 22, y: 68, dx: 2.6, dy: -0.4, work: "feed", label: "喂鸡" },
  { x: 57, y: 58, dx: 2.2, dy: -1.4, work: "harvest", label: "收菜" },
  { x: 43, y: 50, dx: -2, dy: 1.6, work: "carry", label: "搬箱" },
  { x: 34, y: 75, dx: 2.6, dy: -0.8, work: "sweep", label: "清扫" }
];

const WORKER_VARIANTS = [
  { id: "berry", left: workerBerryLeftUrl, right: workerBerryRightUrl },
  { id: "blue", left: workerBlueLeftUrl, right: workerBlueRightUrl },
  { id: "green", left: workerGreenLeftUrl, right: workerGreenRightUrl },
  { id: "gold", left: workerGoldLeftUrl, right: workerGoldRightUrl },
  { id: "violet", left: workerVioletLeftUrl, right: workerVioletRightUrl },
  { id: "mint", left: workerMintLeftUrl, right: workerMintRightUrl }
];

const STATION_LANES = [
  { x: 0, y: 0 },
  { x: -3.8, y: 3.2 },
  { x: 3.8, y: -3.2 },
  { x: -7.2, y: -1.8 },
  { x: 7.2, y: 1.8 },
  { x: -2.4, y: -6.4 },
  { x: 2.4, y: 6.4 },
  { x: -8.4, y: 5.4 },
  { x: 8.4, y: -5.4 }
];

const actorSlotCache = new Map();
let nextActorSlot = 0;
let cachedVisualActors = [];

function normalizeActors(actors) {
  return Array.isArray(actors)
    ? actors
        .map((actor) => ({
          id: String(actor?.id ?? "").trim(),
          conversationId: String(actor?.conversationId ?? actor?.id ?? "").trim(),
          title: String(actor?.title ?? "活跃会话").trim() || "活跃会话",
          type: String(actor?.type ?? "main").trim() === "subagent" ? "subagent" : "main"
        }))
        .filter((actor) => actor.id && actor.conversationId)
    : [];
}

function clampPercent(value, min = 4, max = 96) {
  return Math.min(max, Math.max(min, value));
}

function slotForActor(actor) {
  const actorId = String(actor?.id ?? "").trim();
  if (!actorId) {
    const fallbackSlot = nextActorSlot;
    nextActorSlot += 1;
    return fallbackSlot;
  }

  if (!actorSlotCache.has(actorId)) {
    actorSlotCache.set(actorId, nextActorSlot);
    nextActorSlot += 1;
  }

  return actorSlotCache.get(actorId);
}

function stationForSlot(slot) {
  const stationIndex = slot % WORK_STATIONS.length;
  const laneIndex = Math.floor(slot / WORK_STATIONS.length);
  const baseStation = WORK_STATIONS[stationIndex];
  const lane = STATION_LANES[laneIndex % STATION_LANES.length];
  const ring = Math.floor(laneIndex / STATION_LANES.length);
  const ringShift = ring * 2.7;
  const ringSign = ring % 2 === 0 ? 1 : -1;

  return {
    ...baseStation,
    x: clampPercent(baseStation.x + lane.x + ringShift * ringSign),
    y: clampPercent(baseStation.y + lane.y - ringShift * ringSign),
    dx: baseStation.dx * (laneIndex % 2 === 0 ? 1 : 0.82),
    dy: baseStation.dy * (laneIndex % 2 === 0 ? 1 : 0.82)
  };
}

function stationForActor(actor) {
  return stationForSlot(slotForActor(actor));
}

function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function variantFor(actor) {
  return WORKER_VARIANTS[hashString(actor.id) % WORKER_VARIANTS.length];
}

function createVisualActor(actor) {
  return {
    ...actor,
    status: "entering",
    station: stationForActor(actor),
    variant: variantFor(actor),
    tone: actor.type === "subagent" ? "subagent" : "main"
  };
}

function useVisualActors(actors) {
  const normalizedActors = useMemo(() => normalizeActors(actors), [actors]);
  const [visualActors, setVisualActorsState] = useState(() =>
    cachedVisualActors.map((actor) => ({
      ...actor,
      status: actor.status === "exiting" ? "exiting" : "active"
    }))
  );

  function setVisualActors(updater) {
    setVisualActorsState((previous) => {
      const next = typeof updater === "function" ? updater(previous) : updater;
      cachedVisualActors = next;
      return next;
    });
  }

  useEffect(() => {
    const incomingById = new Map(normalizedActors.map((actor) => [actor.id, actor]));
    const exitTimers = [];

    setVisualActors((previous) => {
      const nextActors = [];
      const seen = new Set();

      previous.forEach((visualActor) => {
        const incoming = incomingById.get(visualActor.id);
        if (incoming) {
          seen.add(visualActor.id);
          nextActors.push({
            ...visualActor,
            ...incoming,
            variant: visualActor.variant ?? variantFor(incoming),
            status: "active"
          });
          return;
        }

        if (visualActor.status !== "exiting") {
          nextActors.push({
            ...visualActor,
            status: "exiting"
          });
          exitTimers.push(visualActor.id);
          return;
        }

        nextActors.push(visualActor);
      });

      normalizedActors.forEach((actor) => {
        if (!seen.has(actor.id)) {
          nextActors.push(createVisualActor(actor));
        }
      });

      return nextActors.map((actor) => ({
        ...actor,
        station: actor.status === "exiting" ? actor.station : actor.station ?? stationForActor(actor),
        variant: actor.variant ?? variantFor(actor),
        tone: actor.type === "subagent" ? "subagent" : "main"
      }));
    });

    const timers = exitTimers.map((actorId) =>
      window.setTimeout(() => {
        setVisualActors((previous) => previous.filter((actor) => actor.id !== actorId));
      }, EXIT_MS)
    );

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [normalizedActors]);

  return { normalizedActors, visualActors };
}

function workerStyle(actor) {
  const isExiting = actor.status === "exiting";
  const from = isExiting ? actor.station : DOOR_POINT;
  const to = isExiting ? DOOR_POINT : actor.station;
  const variant = actor.variant ?? WORKER_VARIANTS[0];

  return {
    "--worker-x": `${actor.station.x}%`,
    "--worker-y": `${actor.station.y}%`,
    "--worker-from-x": `${from.x}%`,
    "--worker-from-y": `${from.y}%`,
    "--worker-to-x": `${to.x}%`,
    "--worker-to-y": `${to.y}%`,
    "--work-dx": `${actor.station.dx}%`,
    "--work-dy": `${actor.station.dy}%`,
    "--route-dx": `${actor.station.dx * 0.72}%`,
    "--route-dy": `${actor.station.dy * 0.72}%`,
    "--worker-sprite-left": `url("${variant.left}")`,
    "--worker-sprite-right": `url("${variant.right}")`
  };
}

function workerClassName(actor) {
  const facesLeftFirst = Number(actor.station.dx) < 0;

  return [
    "cozy-worker",
    `does-${actor.station.work}`,
    `is-${actor.tone}`,
    `variant-${actor.variant?.id ?? "berry"}`,
    facesLeftFirst ? "faces-left-first" : "faces-right-first",
    `is-${actor.status}`
  ].join(" ");
}

function WorkProp({ work }) {
  return (
    <span className={`cozy-work-prop prop-${work}`} aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

function FarmActor({ actor, onActorClick }) {
  return (
    <button
      type="button"
      className={workerClassName(actor)}
      style={workerStyle(actor)}
      title={`${actor.title}：${actor.station.label}`}
      onClick={() => {
        if (actor.status !== "exiting") {
          onActorClick?.(actor);
        }
      }}
    >
      <span className="cozy-worker-shadow" />
      <span className="cozy-worker-sprite worker-sprite-left" />
      <span className="cozy-worker-sprite worker-sprite-right" />
      <WorkProp work={actor.station.work} />
      <span className="cozy-worker-title">{actor.title}</span>
      <span className="cozy-worker-action">{actor.station.label}</span>
      <span className="cozy-worker-done">✓</span>
    </button>
  );
}

function NpcWorker() {
  return (
    <div
      className="cozy-worker cozy-npc does-sweep is-active variant-green"
      style={{
        "--work-dx": "1.8%",
        "--work-dy": "-0.55%",
        "--worker-sprite-left": `url("${workerGreenLeftUrl}")`,
        "--worker-sprite-right": `url("${workerGreenRightUrl}")`
      }}
      aria-label="固定 NPC 正在清扫"
    >
      <span className="cozy-worker-shadow" />
      <span className="cozy-worker-sprite npc-sprite-left" />
      <span className="cozy-worker-sprite npc-sprite-right" />
      <WorkProp work="sweep" />
      <span className="cozy-worker-title">NPC</span>
    </div>
  );
}

function WitchNpc() {
  return (
    <div
      className="witch-npc"
      style={{
        "--witch-sprite-nesw": `url("${witchNeswUrl}")`,
        "--witch-sprite-swen": `url("${witchSwenUrl}")`
      }}
      aria-label="女巫 NPC 在家门口巡逻"
    >
      <span className="witch-shadow" />
      <span className="witch-sprite witch-north" />
      <span className="witch-sprite witch-east" />
      <span className="witch-sprite witch-south" />
      <span className="witch-sprite witch-west" />
      <span className="witch-name">Witch</span>
    </div>
  );
}

export function ActiveScenePanel({ actors, onActorClick }) {
  const { normalizedActors, visualActors } = useVisualActors(actors);

  return (
    <div className="active-scene-panel" aria-label="活跃会话农场">
      <header className="active-scene-header">
        <div>
          <p>YYZ FARM</p>
          <h2>会话农场</h2>
        </div>
        <div className="active-scene-counter">
          <span>干活小人</span>
          <strong>{normalizedActors.length}</strong>
        </div>
      </header>

      <div className="active-scene-board">
        <div
          className="cozy-farm-stage"
          style={{ "--farm-background": `url("${farmBackgroundUrl}")` }}
        >
          <NpcWorker />
          <WitchNpc />
          {visualActors.map((actor) => (
            <FarmActor key={actor.id} actor={actor} onActorClick={onActorClick} />
          ))}
        </div>
        <div className="active-scene-hint">
          {normalizedActors.length > 0
            ? "活跃会话会变成农场小人，在对应工位来回移动并干活；点击小人跳转会话。"
            : "没有活跃会话，固定 NPC 正在农场清扫。"}
        </div>
      </div>
    </div>
  );
}
