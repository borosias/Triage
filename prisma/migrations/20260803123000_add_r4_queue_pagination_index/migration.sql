DROP INDEX "Item_workspaceId_status_idx";

CREATE INDEX "Item_workspaceId_status_createdAt_id_idx"
ON "Item"("workspaceId", "status", "createdAt" DESC, "id" DESC);
