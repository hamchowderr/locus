-- Better Auth's generated schema leaves invitation.inviter_id unindexed, and auth-schema.ts
-- is generated, so the index lives here. Deleting a user cascades through this column.
CREATE INDEX `invitation_inviterId_idx` ON `invitation` (`inviter_id`);
