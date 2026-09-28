import { CommonMergeManyQueryRunnerService } from 'src/engine/api/common/common-query-runners/common-merge-many-query-runner.service';

jest.mock(
  'src/engine/api/graphql/graphql-query-runner/utils/build-columns-to-return',
  () => ({ buildColumnsToReturn: () => ['id', 'name', 'scopePath'] }),
);

// ─────────────────────────────────────────────────────────────────────────────
// SENTINEL SPEC. It defends a Snetor patch in upstream code: the native merge
// must not write `scopePath` through the user's repository.
//
// Why: Sales and Manager roles carry `canUpdateFieldValue=false` on
// `scopePath` — the field the portfolio filter reads to decide who sees what.
// The native merge puts every non-system field in its SET, so a Manager hit
// "no permission to write field scopePath on company" and could not merge two
// duplicates (reported 2026-09-28). The lock stays; the merge writes
// `scopePath` in system context instead, after the user's own update of the
// same record succeeded.
//
// 🔴 If this fails after an upstream merge, a Snetor patch was dropped. Do not
// adjust the expectation: find where the hook went.
// ─────────────────────────────────────────────────────────────────────────────

const buildQueryBuilder = () => {
  const queryBuilder: { where: jest.Mock } = { where: jest.fn() };

  queryBuilder.where.mockReturnValue(queryBuilder);

  return queryBuilder;
};

const setup = ({
  priorityScopePath,
  mergedScopePath,
}: {
  priorityScopePath: string | null;
  mergedScopePath: string | undefined;
}) => {
  const userRepository = {
    createQueryBuilder: jest.fn(buildQueryBuilder),
    runMutation: jest.fn(async () => [{ id: 'a' }]),
  };
  const systemRepository = { update: jest.fn(async () => undefined) };

  const transactionScope = {
    getRepository: jest.fn((_alias: string, config?: object) =>
      config && 'shouldBypassPermissionChecks' in config
        ? systemRepository
        : userRepository,
    ),
  };

  const mergedData: Record<string, unknown> = { name: 'ACME' };

  if (mergedScopePath !== undefined) {
    mergedData.scopePath = mergedScopePath;
  }

  const runner = Object.create(
    CommonMergeManyQueryRunnerService.prototype,
  ) as any;

  Object.assign(runner, {
    workspaceOrmManager: {
      runInWorkspaceTransaction: (work: (scope: unknown) => unknown) =>
        work(transactionScope),
    },
    metricsService: { incrementCounterBy: jest.fn() },
    fetchRecordsToMerge: jest.fn(async () => [
      { id: 'a', name: 'ACME', scopePath: priorityScopePath },
      { id: 'b', name: 'Acme SA', scopePath: '|g:1|' },
    ]),
    performDeepMerge: jest.fn(() => mergedData),
    getRelationFieldsPointingToCurrentObject: () => [],
    resolveNestedRelations: jest.fn(
      async ({ records }: { records: unknown[] }) => records,
    ),
    processNestedRelations: jest.fn(),
  });

  const run = () =>
    runner.run(
      {
        ids: ['a', 'b'],
        conflictPriorityIndex: 0,
        dryRun: false,
        selectedFieldsResult: { select: {}, relations: undefined },
      },
      {
        flatObjectMetadata: { nameSingular: 'company' },
        flatObjectMetadataMaps: {},
        flatFieldMetadataMaps: {},
        flatIndexMaps: {},
        rolePermissionConfig: { unionOf: ['manager-role'] },
      },
    );

  const userUpdateData = () =>
    (userRepository.runMutation.mock.calls as any[])
      .map(([call]) => call)
      .find((call) => call.kind === 'update')?.data;

  return {
    run,
    userRepository,
    systemRepository,
    transactionScope,
    userUpdateData,
  };
};

describe('CommonMergeManyQueryRunnerService — scopePath outside the user SET', () => {
  it('never puts scopePath in the update made with the user permissions', async () => {
    const { run, userUpdateData } = setup({
      priorityScopePath: '|g:2|',
      mergedScopePath: '|g:2|',
    });

    await run();

    expect(userUpdateData()).toEqual({ name: 'ACME' });
  });

  it('writes the consolidated scopePath in system context when it changes', async () => {
    const { run, systemRepository, transactionScope, userUpdateData } = setup({
      priorityScopePath: null,
      mergedScopePath: '|g:1|',
    });

    await run();

    expect(userUpdateData()).toEqual({ name: 'ACME' });
    expect(transactionScope.getRepository).toHaveBeenCalledWith('company', {
      shouldBypassPermissionChecks: true,
    });
    expect(systemRepository.update).toHaveBeenCalledWith('a', {
      scopePath: '|g:1|',
    });
  });

  it('writes scopePath only after the user update of the same record succeeded', async () => {
    const { run, userRepository, systemRepository } = setup({
      priorityScopePath: null,
      mergedScopePath: '|g:1|',
    });

    await run();

    const lastUserMutation = Math.max(
      ...userRepository.runMutation.mock.invocationCallOrder,
    );

    expect(systemRepository.update.mock.invocationCallOrder[0]).toBeGreaterThan(
      lastUserMutation,
    );
  });

  it('skips the system write when the priority record already holds the value', async () => {
    const { run, systemRepository } = setup({
      priorityScopePath: '|g:2|',
      mergedScopePath: '|g:2|',
    });

    await run();

    expect(systemRepository.update).not.toHaveBeenCalled();
  });

  it('skips the system write when no merged record carries a scopePath', async () => {
    const { run, systemRepository, userUpdateData } = setup({
      priorityScopePath: null,
      mergedScopePath: undefined,
    });

    await run();

    expect(userUpdateData()).toEqual({ name: 'ACME' });
    expect(systemRepository.update).not.toHaveBeenCalled();
  });
});
