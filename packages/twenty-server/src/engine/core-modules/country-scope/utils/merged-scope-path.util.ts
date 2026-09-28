import { type ObjectRecord } from 'twenty-shared/types';

import { type WorkspaceTransactionScope } from 'src/engine/twenty-orm/types/workspace-transaction-scope.type';
import { SCOPE_PATH_FIELD } from 'src/engine/twenty-orm/utils/resolve-country-scope.util';

// Let the native merge consolidate `scopePath` without granting anyone the right to write it.
//
// **The problem.** Sales and Manager roles carry `canUpdateFieldValue=false` on `scopePath`:
// it is the field the portfolio filter reads, and a role that could write it could widen its
// own perimeter. The native merge puts every non-system field of the merged record in one
// SET, run with the user's permissions — so the lock refused it with
// "no permission to write field scopePath on company", and a Manager could not merge two
// duplicates (Carla RIBEIRO, 2026-09-28).
//
// **The fix.** Take `scopePath` out of the user's SET, then write the value the merge
// computed — upstream's own rule, the priority record's value or else the first non-empty
// one — in system context. Same principle as `ScopePathOnCreateListener`.
//
// ⚠️ Why this does not reopen the lock:
// - the user never chooses the value: it is one the merged records already carried, and the
//   user could read every one of them (the merge fetches them through the portfolio filter);
// - the system write runs after the user's own update of the same record succeeded in the
//   same transaction, so object-level Update permission and row visibility are already proven;
// - the transaction repository keeps the user's `authContext`, so the portfolio filter still
//   applies to this write — only the role checks are bypassed;
// - `compute_scope_paths.py` stays the owner of the value and recomputes it from `sapClientId`.

export const splitMergedScopePath = (
  mergedData: Partial<ObjectRecord>,
  priorityRecord: ObjectRecord,
): {
  mergedData: Partial<ObjectRecord>;
  scopePathToWrite: string | undefined;
} => {
  const { [SCOPE_PATH_FIELD]: mergedScopePath, ...rest } = mergedData;

  return {
    mergedData: rest,
    scopePathToWrite:
      typeof mergedScopePath === 'string' &&
      mergedScopePath !== priorityRecord[SCOPE_PATH_FIELD]
        ? mergedScopePath
        : undefined,
  };
};

export const writeMergedScopePathAsSystem = async ({
  transactionScope,
  objectName,
  recordId,
  scopePath,
}: {
  transactionScope: WorkspaceTransactionScope;
  objectName: string;
  recordId: string;
  scopePath: string | undefined;
}): Promise<void> => {
  if (scopePath === undefined) {
    return;
  }

  await transactionScope
    .getRepository(objectName, { shouldBypassPermissionChecks: true })
    .update(recordId, { [SCOPE_PATH_FIELD]: scopePath });
};
