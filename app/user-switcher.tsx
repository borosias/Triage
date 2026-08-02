"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type SeededUser = {
  id: string;
  name: string;
};

type UserSwitcherProps = {
  users: SeededUser[];
  currentUser: SeededUser | null;
};

export function UserSwitcher({ users, currentUser }: UserSwitcherProps) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function switchUser(userId: string) {
    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId }),
      });

      if (!response.ok) {
        throw new Error("Login failed");
      }

      router.refresh();
    } catch {
      setError("Could not switch user. Try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function logOut() {
    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/session", { method: "DELETE" });

      if (!response.ok) {
        throw new Error("Logout failed");
      }

      router.refresh();
    } catch {
      setError("Could not log out. Try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="space-y-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-slate-700">
        <span>Current user:</span>{" "}
        <strong className="font-semibold text-slate-950">
          {currentUser?.name ?? "Not signed in"}
        </strong>
      </p>

      <div className="flex items-end gap-3">
        <label className="grid gap-1 text-sm font-medium text-slate-700">
          Switch user
          <select
            className="min-w-48 rounded-md border border-slate-300 bg-white px-3 py-2 text-slate-950 disabled:opacity-60"
            value={currentUser?.id ?? ""}
            disabled={isSubmitting}
            onChange={(event) => void switchUser(event.target.value)}
          >
            <option value="" disabled>
              Select a seeded user
            </option>
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name}
              </option>
            ))}
          </select>
        </label>

        {currentUser ? (
          <button
            className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60"
            type="button"
            disabled={isSubmitting}
            onClick={() => void logOut()}
          >
            Log out
          </button>
        ) : null}
      </div>

      {error ? (
        <p className="text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
