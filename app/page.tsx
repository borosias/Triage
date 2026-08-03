import { UserSwitcher } from "@/app/user-switcher";
import { WorkspaceQueue } from "@/app/workspace-queue";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { unstable_rethrow } from "next/navigation";

async function loadHomeData() {
  try {
    const [users, currentUser] = await Promise.all([
      db.user.findMany({
        select: { id: true, name: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
      getCurrentUser(),
    ]);

    return {
      users,
      currentUser: currentUser
        ? { id: currentUser.id, name: currentUser.name }
        : null,
    };
  } catch (error) {
    unstable_rethrow(error);
    return null;
  }
}

export default async function Home() {
  const data = await loadHomeData();

  if (!data) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6 font-sans">
        <p>Unable to load the seeded users. Try again later.</p>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-slate-50 p-6 font-sans">
      <div className="mx-auto max-w-5xl space-y-6 pt-16">
        <div>
          <h1 className="text-2xl font-semibold text-slate-950">Flamingo</h1>
          <p className="mt-1 text-sm text-slate-600">
            Choose a seeded user for this development session.
          </p>
        </div>

        <UserSwitcher users={data.users} currentUser={data.currentUser} />
        <WorkspaceQueue
          key={data.currentUser?.id ?? "anonymous"}
          currentUser={data.currentUser}
        />
      </div>
    </main>
  );
}
