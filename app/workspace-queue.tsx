"use client";

import { useEffect, useState } from "react";

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

type LoadState = "idle" | "loading" | "ready" | "error";

type ClaimResponse = {
  error?: string;
  item?: QueueItem;
};

type WorkspaceQueueProps = {
  currentUser: CurrentUser | null;
};

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
  const [pendingItemIds, setPendingItemIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [claimErrors, setClaimErrors] = useState<Record<string, string>>({});

  const currentUserId = currentUser?.id ?? null;
  const selectedWorkspace = workspaces.find(
    (workspace) => workspace.id === selectedWorkspaceId,
  );
  const canClaimItems =
    selectedWorkspace?.role === "OWNER" || selectedWorkspace?.role === "MEMBER";

  useEffect(() => {
    if (!currentUserId) {
      return;
    }

    const controller = new AbortController();

    async function loadWorkspaces() {
      setWorkspaceState("loading");
      setWorkspaces([]);
      setSelectedWorkspaceId(null);
      setItems([]);
      setQueueState("idle");
      setPendingItemIds(new Set());
      setClaimErrors({});

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

    async function loadItems() {
      setQueueState("loading");
      setItems([]);
      setPendingItemIds(new Set());
      setClaimErrors({});

      try {
        const response = await fetch(
          `/api/workspaces/${selectedWorkspaceId}/items`,
          { signal: controller.signal },
        );

        if (!response.ok) {
          throw new Error("Queue request failed");
        }

        const body = (await response.json()) as { items: QueueItem[] };

        setItems(body.items);
        setQueueState("ready");
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }

        setQueueState("error");
      }
    }

    void loadItems();

    return () => controller.abort();
  }, [queueReload, selectedWorkspaceId]);

  async function claimItem(item: QueueItem) {
    setPendingItemIds((current) => new Set(current).add(item.id));
    setClaimErrors((current) => {
      const next = { ...current };
      delete next[item.id];
      return next;
    });

    try {
      const response = await fetch(
        `/api/workspaces/${item.workspaceId}/items/${item.id}/claim`,
        { method: "POST" },
      );
      const body = (await response.json()) as ClaimResponse;

      if ((response.status === 200 || response.status === 409) && body.item) {
        const canonicalItem = body.item;

        setItems((current) =>
          current.map((currentItem) =>
            currentItem.id === canonicalItem.id ? canonicalItem : currentItem,
          ),
        );

        if (response.status === 409) {
          setClaimErrors((current) => ({
            ...current,
            [item.id]: body.error ?? "Another member claimed this item.",
          }));
        }

        return;
      }

      throw new Error(body.error ?? "Claim request failed.");
    } catch (error) {
      setClaimErrors((current) => ({
        ...current,
        [item.id]:
          error instanceof Error
            ? error.message
            : "Could not claim this item. Try again.",
      }));
    } finally {
      setPendingItemIds((current) => {
        const next = new Set(current);
        next.delete(item.id);
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
              setItems([]);
              setQueueState("loading");
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
            onClick={() => setQueueReload((value) => value + 1)}
          >
            Retry
          </button>
        </div>
      ) : null}

      {queueState === "ready" && items.length === 0 ? (
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
              {items.map((item) => (
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
                    {item.claimedBy || !canClaimItems ? (
                      <span aria-hidden="true">&mdash;</span>
                    ) : (
                      <button
                        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 disabled:opacity-60"
                        type="button"
                        disabled={pendingItemIds.has(item.id)}
                        onClick={() => void claimItem(item)}
                      >
                        {pendingItemIds.has(item.id) ? "Claiming..." : "Claim"}
                      </button>
                    )}
                    {claimErrors[item.id] ? (
                      <p className="mt-1 text-xs text-red-700" role="alert">
                        {claimErrors[item.id]}
                      </p>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
