"use client";

import { useEffect, useRef, useState } from "react";

type CurrentUser = {
  id: string;
  name: string;
};

type Workspace = {
  id: string;
  name: string;
  role: "OWNER" | "MEMBER" | "VIEWER";
};

type QueueItem = {
  id: string;
  workspaceId: string;
  title: string;
  status: "OPEN";
  claimedById: string | null;
  claimedAt: string | null;
  createdAt: string;
  claimedBy: {
    id: string;
    name: string;
  } | null;
};

type ItemActionItem =
  | QueueItem
  | (Omit<QueueItem, "status"> & { status: "RESOLVED" });

type LoadState = "idle" | "loading" | "ready" | "error";

type LoadMoreState = "idle" | "loading" | "error";

type ItemAction = "claim" | "release" | "resolve";

type ItemActionResponse = {
  error?: string;
  item?: ItemActionItem;
};

type QueueNotice = {
  kind: "success" | "error";
  message: string;
};

type WorkspaceQueueProps = {
  currentUser: CurrentUser | null;
};

type QueueResponse = {
  items: QueueItem[];
  nextCursor: string | null;
};

const queueRevalidationIntervalMs = 10_000;

export function reconcileQueueAfterItemAction(
  items: QueueItem[],
  canonicalItem: ItemActionItem,
) {
  if (canonicalItem.status === "RESOLVED") {
    return items.filter((item) => item.id !== canonicalItem.id);
  }

  return items.map((item) =>
    item.id === canonicalItem.id ? canonicalItem : item,
  );
}

export function WorkspaceQueue({ currentUser }: WorkspaceQueueProps) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    null,
  );
  const [items, setItems] = useState<QueueItem[]>([]);
  const [workspaceState, setWorkspaceState] = useState<LoadState>("idle");
  const [queueState, setQueueState] = useState<LoadState>("idle");
  const [workspaceReload, setWorkspaceReload] = useState(0);
  const [queueReload, setQueueReload] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadMoreState, setLoadMoreState] =
    useState<LoadMoreState>("idle");
  const [hasLoadedContinuation, setHasLoadedContinuation] = useState(false);
  const [pendingItemActions, setPendingItemActions] = useState<
    Record<string, ItemAction>
  >({});
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [queueNotice, setQueueNotice] = useState<QueueNotice | null>(null);
  const queueGenerationRef = useRef(0);

  const currentUserId = currentUser?.id ?? null;
  const selectedWorkspace = workspaces.find(
    (workspace) => workspace.id === selectedWorkspaceId,
  );
  const canClaimItems =
    selectedWorkspace?.role === "OWNER" || selectedWorkspace?.role === "MEMBER";
  const pendingItemActionCount = Object.keys(pendingItemActions).length;

  useEffect(() => {
    if (!currentUserId) {
      return;
    }

    const controller = new AbortController();

    async function loadWorkspaces() {
      queueGenerationRef.current += 1;
      setWorkspaceState("loading");
      setWorkspaces([]);
      setSelectedWorkspaceId(null);
      setItems([]);
      setQueueState("idle");
      setNextCursor(null);
      setLoadMoreState("idle");
      setHasLoadedContinuation(false);
      setPendingItemActions({});
      setActionErrors({});
      setQueueNotice(null);

      try {
        const response = await fetch("/api/workspaces", {
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error("Workspace request failed");
        }

        const body = (await response.json()) as { workspaces: Workspace[] };

        setWorkspaces(body.workspaces);
        setSelectedWorkspaceId(body.workspaces[0]?.id ?? null);
        setWorkspaceState("ready");
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }

        setWorkspaceState("error");
      }
    }

    void loadWorkspaces();

    return () => controller.abort();
  }, [currentUserId, workspaceReload]);

  useEffect(() => {
    if (!selectedWorkspaceId) {
      return;
    }

    const controller = new AbortController();
    const generation = queueGenerationRef.current + 1;
    queueGenerationRef.current = generation;

    async function loadItems() {
      setQueueState("loading");
      setItems([]);
      setNextCursor(null);
      setLoadMoreState("idle");
      setHasLoadedContinuation(false);
      setPendingItemActions({});
      setActionErrors({});
      setQueueNotice(null);

      try {
        const response = await fetch(
          `/api/workspaces/${selectedWorkspaceId}/items`,
          { signal: controller.signal },
        );

        if (!response.ok) {
          throw new Error("Queue request failed");
        }

        const body = (await response.json()) as QueueResponse;

        if (queueGenerationRef.current !== generation) {
          return;
        }

        setItems(body.items);
        setNextCursor(body.nextCursor);
        setQueueState("ready");
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }

        if (queueGenerationRef.current === generation) {
          setQueueState("error");
        }
      }
    }

    void loadItems();

    return () => controller.abort();
  }, [queueReload, selectedWorkspaceId]);

  useEffect(() => {
    if (
      !selectedWorkspaceId ||
      queueState !== "ready" ||
      loadMoreState === "loading" ||
      hasLoadedContinuation ||
      pendingItemActionCount > 0
    ) {
      return;
    }

    const workspaceId = selectedWorkspaceId;
    const generation = queueGenerationRef.current;
    let controller: AbortController | null = null;
    let disposed = false;
    let requestInFlight = false;

    async function revalidateQueue() {
      if (
        disposed ||
        requestInFlight ||
        document.visibilityState !== "visible"
      ) {
        return;
      }

      requestInFlight = true;
      controller = new AbortController();

      try {
        const response = await fetch(`/api/workspaces/${workspaceId}/items`, {
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error("Queue revalidation failed");
        }

        const body = (await response.json()) as QueueResponse;

        if (disposed || queueGenerationRef.current !== generation) {
          return;
        }

        setItems(body.items);
        setNextCursor(body.nextCursor);
        setLoadMoreState("idle");
        setActionErrors({});
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
      } finally {
        requestInFlight = false;
        controller = null;
      }
    }

    function revalidateVisibleQueue() {
      if (document.visibilityState === "visible") {
        void revalidateQueue();
      }
    }

    const intervalId = window.setInterval(
      () => void revalidateQueue(),
      queueRevalidationIntervalMs,
    );
    document.addEventListener("visibilitychange", revalidateVisibleQueue);
    window.addEventListener("focus", revalidateVisibleQueue);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", revalidateVisibleQueue);
      window.removeEventListener("focus", revalidateVisibleQueue);
      controller?.abort();
    };
  }, [
    hasLoadedContinuation,
    loadMoreState,
    pendingItemActionCount,
    queueState,
    selectedWorkspaceId,
  ]);

  async function loadMore() {
    if (
      !selectedWorkspaceId ||
      !nextCursor ||
      loadMoreState === "loading"
    ) {
      return;
    }

    const workspaceId = selectedWorkspaceId;
    const cursor = nextCursor;
    const generation = queueGenerationRef.current + 1;
    queueGenerationRef.current = generation;
    setLoadMoreState("loading");

    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/items?cursor=${encodeURIComponent(cursor)}`,
      );

      if (!response.ok) {
        throw new Error("Pagination request failed");
      }

      const body = (await response.json()) as QueueResponse;

      if (queueGenerationRef.current !== generation) {
        return;
      }

      setItems((current) => [...current, ...body.items]);
      setNextCursor(body.nextCursor);
      setHasLoadedContinuation(true);
      setLoadMoreState("idle");
    } catch {
      if (queueGenerationRef.current === generation) {
        setLoadMoreState("error");
      }
    }
  }

  async function updateItem(item: QueueItem, action: ItemAction) {
    queueGenerationRef.current += 1;
    setPendingItemActions((current) => ({
      ...current,
      [item.id]: action,
    }));
    setActionErrors((current) => {
      const next = { ...current };
      delete next[item.id];
      return next;
    });
    setQueueNotice(null);

    try {
      const response = await fetch(
        `/api/workspaces/${item.workspaceId}/items/${item.id}/${action}`,
        { method: "POST" },
      );
      const body = (await response.json()) as ItemActionResponse;

      if ((response.status === 200 || response.status === 409) && body.item) {
        const canonicalItem = body.item;

        setItems((current) =>
          reconcileQueueAfterItemAction(current, canonicalItem),
        );

        if (response.status === 200 && action === "resolve") {
          setQueueNotice({
            kind: "success",
            message: "Resolved. Notification queued.",
          });
        }

        if (response.status === 409) {
          const errorMessage =
            body.error ??
            (action === "claim"
              ? "Another member claimed this item."
              : action === "release"
                ? "This item could not be released."
                : "This item could not be resolved.");

          if (canonicalItem.status === "RESOLVED") {
            setQueueNotice({ kind: "error", message: errorMessage });
          } else {
            setActionErrors((current) => ({
              ...current,
              [item.id]: errorMessage,
            }));
          }
        }

        return;
      }

      throw new Error(
        body.error ??
          (action === "claim"
            ? "Claim request failed."
            : action === "release"
              ? "Release request failed."
              : "Resolve request failed."),
      );
    } catch (error) {
      setActionErrors((current) => ({
        ...current,
        [item.id]:
          error instanceof Error
            ? error.message
            : `Could not ${action} this item. Try again.`,
      }));
    } finally {
      setPendingItemActions((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
    }
  }

  if (!currentUser) {
    return (
      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <p className="text-sm text-slate-600">
          Select a seeded user to view accessible workspaces and queue items.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-end gap-4">
        <label className="grid gap-1 text-sm font-medium text-slate-700">
          Workspace
          <select
            className="min-w-48 rounded-md border border-slate-300 bg-white px-3 py-2 text-slate-950 disabled:opacity-60"
            value={selectedWorkspaceId ?? ""}
            disabled={workspaceState !== "ready" || workspaces.length === 0}
            onChange={(event) => {
              queueGenerationRef.current += 1;
              setItems([]);
              setQueueState("loading");
              setNextCursor(null);
              setLoadMoreState("idle");
              setHasLoadedContinuation(false);
              setQueueNotice(null);
              setSelectedWorkspaceId(event.target.value);
            }}
          >
            <option value="" disabled>
              {workspaceState === "loading"
                ? "Loading workspaces..."
                : "Select a workspace"}
            </option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </label>

        <p className="pb-2 text-sm text-slate-600">
          Role: {selectedWorkspace?.role ?? "—"}
        </p>
      </div>

      {workspaceState === "error" ? (
        <div className="flex items-center gap-3" role="alert">
          <p className="text-sm text-red-700">Could not load workspaces.</p>
          <button
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700"
            type="button"
            onClick={() => setWorkspaceReload((value) => value + 1)}
          >
            Retry
          </button>
        </div>
      ) : null}

      {workspaceState === "ready" && workspaces.length === 0 ? (
        <p className="text-sm text-slate-600">No accessible workspaces.</p>
      ) : null}

      {queueNotice ? (
        <p
          className={
            queueNotice.kind === "success"
              ? "text-sm text-emerald-700"
              : "text-sm text-red-700"
          }
          role={queueNotice.kind === "success" ? "status" : "alert"}
        >
          {queueNotice.message}
        </p>
      ) : null}

      {queueState === "loading" ? (
        <p className="text-sm text-slate-600">Loading open queue...</p>
      ) : null}

      {queueState === "error" ? (
        <div className="flex items-center gap-3" role="alert">
          <p className="text-sm text-red-700">
            Could not load the open queue.
          </p>
          <button
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700"
            type="button"
            onClick={() => {
              queueGenerationRef.current += 1;
              setQueueReload((value) => value + 1);
            }}
          >
            Retry
          </button>
        </div>
      ) : null}

      {queueState === "ready" &&
      items.length === 0 &&
      nextCursor === null ? (
        <p className="text-sm text-slate-600">The open queue is empty.</p>
      ) : null}

      {queueState === "ready" && items.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-slate-600">
                <th className="px-2 py-2 font-medium">Item</th>
                <th className="px-2 py-2 font-medium">Claimant</th>
                <th className="px-2 py-2 font-medium">Created</th>
                <th className="px-2 py-2 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const pendingAction = pendingItemActions[item.id];
                const isPending = pendingAction !== undefined;

                return (
                  <tr key={item.id} className="border-b border-slate-100">
                    <td className="px-2 py-2 text-slate-950">{item.title}</td>
                    <td className="px-2 py-2 text-slate-700">
                      {item.claimedBy
                        ? `Claimed by ${item.claimedBy.name}`
                        : "Unclaimed"}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-slate-600">
                      {new Date(item.createdAt).toLocaleString()}
                    </td>
                    <td className="px-2 py-2 text-slate-700">
                      {!canClaimItems ? (
                        <span aria-hidden="true">&mdash;</span>
                      ) : item.claimedById === currentUserId ? (
                        <div className="flex flex-wrap gap-2">
                          <button
                            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 disabled:opacity-60"
                            type="button"
                            disabled={isPending}
                            onClick={() => void updateItem(item, "release")}
                          >
                            {pendingAction === "release"
                              ? "Releasing..."
                              : "Release"}
                          </button>
                          <button
                            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
                            type="button"
                            disabled={isPending}
                            onClick={() => void updateItem(item, "resolve")}
                          >
                            {pendingAction === "resolve"
                              ? "Resolving..."
                              : "Resolve"}
                          </button>
                        </div>
                      ) : item.claimedBy ? (
                        <span aria-hidden="true">&mdash;</span>
                      ) : (
                        <button
                          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 disabled:opacity-60"
                          type="button"
                          disabled={isPending}
                          onClick={() => void updateItem(item, "claim")}
                        >
                          {pendingAction === "claim" ? "Claiming..." : "Claim"}
                        </button>
                      )}
                      {actionErrors[item.id] ? (
                        <p className="mt-1 text-xs text-red-700" role="alert">
                          {actionErrors[item.id]}
                        </p>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {queueState === "ready" && nextCursor !== null ? (
        <div className="flex flex-wrap items-center gap-3">
          <button
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 disabled:opacity-60"
            type="button"
            disabled={loadMoreState === "loading"}
            onClick={() => void loadMore()}
          >
            {loadMoreState === "loading" ? "Loading more..." : "Load more"}
          </button>
          {loadMoreState === "error" ? (
            <p className="text-sm text-red-700" role="alert">
              Could not load more items. Try again.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
