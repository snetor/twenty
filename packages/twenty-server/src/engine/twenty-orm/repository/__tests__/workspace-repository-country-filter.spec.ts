import { applyCountryPermissionFilter } from 'src/engine/twenty-orm/utils/apply-country-permission-filter.util';
import { buildMutationQueryBuilder } from 'src/engine/api/common/common-query-runners/utils/build-mutation-query-builder.util';
import { WorkspaceSelectQueryBuilder } from 'src/engine/twenty-orm/query-builder/workspace-select-query-builder';
import {
  PermissionsException,
  PermissionsExceptionCode,
} from 'src/engine/metadata-modules/permissions/permissions.exception';
import { WorkspaceRepository } from 'src/engine/twenty-orm/repository/workspace-repository';

// SWC compile les exports ESM en getters non-configurables → `jest.spyOn` lève
// "Cannot redefine property". On remplace donc le module par une factory mockée.
jest.mock(
  'src/engine/twenty-orm/utils/apply-country-permission-filter.util',
  () => ({ applyCountryPermissionFilter: jest.fn() }),
);

const applyMock = applyCountryPermissionFilter as jest.Mock;

// ─────────────────────────────────────────────────────────────────────────────
// SPEC-SENTINELLE. Elle ne vérifie PAS la forme du prédicat de cloisonnement —
// c'est le rôle de `utils/__tests__/apply-country-permission-filter.util.spec.ts`
// et de ses 34 cas. Elle vérifie que le filtre est encore BRANCHÉ.
//
// 🔴 Si elle échoue après un merge de l'amont, c'est qu'un patch Snetor a sauté.
// Ne pas ajuster l'attente : retrouver où l'accroche a disparu.
//
// Depuis la v2.39.0 le cloisonnement n'a plus que DEUX points d'application, tous
// deux ici, et ils remplacent les cinq patchs dispersés d'avant :
//
//   - LECTURE  : `onBeforeExecute`, le hook que `createQueryBuilder()` injecte dans
//                tout builder de lecture. Il couvre `find`, `getCount()`, le groupBy
//                du Kanban (via `applyRowLevelPermissions()`) et les relations
//                imbriquées. C'est pour ça qu'aucune de ces surfaces n'a plus de
//                patch dédié — et donc pas non plus de sentinelle dédiée.
//   - ÉCRITURE : `runMutation`, traversé par update, delete, soft-delete et restore.
//                🔴 Un UPDATE n'a pas de SELECT préalable : sans ce prédicat, un
//                utilisateur qui connaît un `id` hors de son périmètre écrit dessus.
//                C'était le cas jusqu'au 2026-08-30.
// ─────────────────────────────────────────────────────────────────────────────

const buildRepository = () => {
  const repository = Object.create(
    WorkspaceRepository.prototype,
  ) as WorkspaceRepository<any>;

  Object.assign(repository, {
    options: {
      flatObjectMetadata: { nameSingular: 'company' },
      internalContext: { flatFieldMetadataMaps: {} },
      authContext: { type: 'user', workspaceMember: { id: 'member-1' } },
    },
  });

  return repository;
};

const buildQueryBuilder = () => ({ alias: 'company' }) as any;

describe('WorkspaceRepository — branchement du cloisonnement par portefeuille', () => {
  beforeEach(() => {
    applyMock.mockClear();
  });

  describe('LECTURE — onBeforeExecute', () => {
    it('appelle le filtre de portée pour toute lecture', () => {
      const repository = buildRepository();
      const queryBuilder = buildQueryBuilder();

      // Les deux voisines amont ne sont pas le sujet : on les neutralise.
      (repository as any).applyRowLevelPermissionPredicates = jest.fn();
      (repository as any).validateQueryIsPermitted = jest.fn();

      (repository as any).onBeforeExecute(queryBuilder);

      expect(applyMock).toHaveBeenCalledTimes(1);
      expect(applyMock).toHaveBeenCalledWith(
        expect.objectContaining({ queryBuilder }),
      );
    });

    it('transmet bien le contexte utilisateur — sans lui le filtre s abstient', () => {
      const repository = buildRepository();

      (repository as any).applyRowLevelPermissionPredicates = jest.fn();
      (repository as any).validateQueryIsPermitted = jest.fn();

      (repository as any).onBeforeExecute(buildQueryBuilder());

      expect(applyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          authContext: expect.objectContaining({ type: 'user' }),
          objectMetadata: expect.objectContaining({ nameSingular: 'company' }),
        }),
      );
    });
  });

  describe('ÉCRITURE — runMutation', () => {
    // On laisse `runMutation` échouer après notre point d'application : ce qui suit
    // (snapshot d'événements, exécuteur SQL) demande une vraie connexion, et ce
    // n'est pas ce qu'on mesure. L'assertion porte sur l'appel, pas sur l'issue.
    const runMutationIgnoringDownstream = async (
      repository: WorkspaceRepository<any>,
      rowLevelPermissionsApplied: boolean,
      kind = 'update',
    ) => {
      // Upstream (v2.45) validates and formats the write BEFORE reaching our hook; the
      // stub has no field metadata, so those neighbours are neutralised, like the read side.
      (repository as any).validateWriteIsPermitted = jest.fn();
      (repository as any).formatWriteData = jest.fn().mockReturnValue({});

      try {
        await (repository as any).runMutation({
          selectQueryBuilder: buildQueryBuilder(),
          rowLevelPermissionsApplied,
          kind,
          columnsToReturn: ['id'],
          data: { name: 'x' },
        });
      } catch {
        // attendu : l'aval n'est pas branché dans ce test
      }
    };

    it.each(['update', 'delete', 'soft-delete', 'restore'])(
      'applique le filtre sur un %s quand les prédicats ne sont pas déjà posés',
      async (kind) => {
        const repository = buildRepository();

        (repository as any).applyRowLevelPermissionPredicates = jest.fn();

        await runMutationIgnoringDownstream(repository, false, kind);

        expect(applyMock).toHaveBeenCalledTimes(1);
      },
    );

    it('ne l applique pas une seconde fois dans runMutation quand l appelant l a déjà posé', async () => {
      const repository = buildRepository();

      (repository as any).applyRowLevelPermissionPredicates = jest.fn();

      // `rowLevelPermissionsApplied: true` means the CALLER applied the predicates, through
      // `applyWriteRowLevelPermissions`, which applies the Snetor filter too (next tests).
      // Re-applying it here would only duplicate the condition.
      await runMutationIgnoringDownstream(repository, true);

      expect(applyMock).not.toHaveBeenCalled();
    });
  });

  // 🔴 Write bypass found by the security review of the v2.45.6 upgrade (it predates it).
  // A bulk update/delete whose filter traverses a relation takes the
  // `rowLevelPermissionsApplied: true` path: `buildMutationQueryBuilder` applies the
  // predicates itself, through `applyWriteRowLevelPermissions`, and `performMutation` then
  // skips the Snetor filter. If `applyWriteRowLevelPermissions` does not apply it, that path
  // writes on out-of-scope rows.
  describe('ÉCRITURE EN MASSE À TRAVERS UNE RELATION — applyWriteRowLevelPermissions', () => {
    it.each(['update', 'delete', 'soft-delete', 'restore'] as const)(
      'applique le filtre de portée sur la sous-requête d ids d un %s',
      (kind) => {
        const repository = buildRepository();
        const queryBuilder = buildQueryBuilder();

        (repository as any).applyRowLevelPermissionPredicates = jest.fn();

        repository.applyWriteRowLevelPermissions(queryBuilder, kind);

        expect(applyMock).toHaveBeenCalledTimes(1);
        expect(applyMock).toHaveBeenCalledWith(
          expect.objectContaining({ queryBuilder }),
        );
      },
    );

    it('bout en bout : la voie relationnelle de buildMutationQueryBuilder pose le filtre de portée', () => {
      const repository = buildRepository();
      const idSubQueryBuilder = {
        alias: 'company',
        getQuery: () => 'SELECT 1',
        getParameters: () => ({}),
      };
      const filteredQueryBuilder = {
        alias: 'company',
        getJoinAliases: () => [{ name: 'people', isToMany: true }],
        select: () => ({ withDeleted: () => idSubQueryBuilder }),
      };
      const outer = {
        where: () => ({ setParameters: () => outer }),
      };

      (repository as any).applyRowLevelPermissionPredicates = jest.fn();
      (repository as any).createQueryBuilder = jest
        .fn()
        .mockReturnValueOnce(filteredQueryBuilder)
        .mockReturnValueOnce(outer);

      const result = buildMutationQueryBuilder({
        repository,
        alias: 'company',
        filter: {},
        commonQueryParser: { applyFilterToBuilder: jest.fn() } as any,
        kind: 'update',
      });

      // The relational path reports `true` (so `performMutation` will not apply the
      // filter again) ...
      expect(result.rowLevelPermissionsApplied).toBe(true);
      // ... which is only safe because the filter was applied on the id sub-query.
      expect(applyMock).toHaveBeenCalledTimes(1);
      expect(applyMock).toHaveBeenCalledWith(
        expect.objectContaining({ queryBuilder: idSubQueryBuilder }),
      );
    });
  });

  // `runBatchUpdate` (save, upsert, updateMany, create-many upserts) pre-selects the ids it
  // may write through `createQueryBuilder()`, whose hook applies the filter; the per-record
  // UPDATE then only touches those ids.
  describe('ÉCRITURE PAR LOT — runBatchUpdate', () => {
    it('createQueryBuilder() injecte bien le filtre de portée dans son hook de lecture', () => {
      const repository = buildRepository();

      (repository as any).applyRowLevelPermissionPredicates = jest.fn();
      (repository as any).validateQueryIsPermitted = jest.fn();
      Object.assign((repository as any).options, {
        tableShape: { nameSingular: 'company' },
      });
      Object.defineProperty(repository, 'isRecordSharingEnabled', {
        value: false,
      });

      const queryBuilder = repository.createQueryBuilder();

      expect(queryBuilder).toBeInstanceOf(WorkspaceSelectQueryBuilder);

      queryBuilder.applyRowLevelPermissions();

      expect(applyMock).toHaveBeenCalledTimes(1);
    });

    it('resolveWritableRecordIds lit les ids par le builder filtré, pas par un builder qui contourne', async () => {
      const repository = buildRepository();
      const hooked = {
        where: jest.fn().mockReturnThis(),
        withDeleted: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([{ id: 'a' }]),
      };

      (repository as any).applyRowLevelPermissionPredicates = jest.fn();
      (repository as any).createQueryBuilder = jest
        .fn()
        .mockReturnValue(hooked);

      const ids = await (repository as any).resolveWritableRecordIds({
        ids: ['a', 'b'],
        operationType: 'update',
      });

      expect((repository as any).createQueryBuilder).toHaveBeenCalledTimes(1);
      expect([...ids]).toEqual(['a']);
    });
  });

  // `validateParentRecordsAreWritableOrThrow` (creating or attaching a child under a parent,
  // e.g. a note or task target) reads the parent through `applyWriteRowLevelPermissions`, which
  // now carries the Snetor filter. The fake builder below mirrors the real flow: `getMany()`
  // fires the repository's `onBeforeExecute` hook, and the (mocked) filter then restricts the
  // rows to the in-scope ones. An in-scope parent must stay writable, an out-of-scope one must
  // be refused.
  describe('PARENT WRITABILITY CHECK — validateInheritedParentsAreWritableOrThrow', () => {
    const IN_SCOPE_PARENT = 'company-in-scope';
    const OUT_OF_SCOPE_PARENT = 'company-out-of-scope';

    const buildChildRepository = () => {
      const parentRepository = buildRepository();

      (parentRepository as any).applyRowLevelPermissionPredicates = jest.fn();
      (parentRepository as any).validateQueryIsPermitted = jest.fn();

      let requestedIds: string[] = [];

      (parentRepository as any).createQueryBuilder = () => {
        const fake: any = {
          alias: 'company',
          scoped: false,
          where: (criteria: { id: { value: string[] } }) => {
            requestedIds = criteria.id.value;

            return fake;
          },
          withDeleted: () => fake,
          select: () => fake,
          // Same order as the real builder: hook first, then the SQL runs.
          getMany: async () => {
            (parentRepository as any).onBeforeExecute(fake);

            return requestedIds
              .filter((id) => !fake.scoped || id === IN_SCOPE_PARENT)
              .map((id) => ({ id }));
          },
        };

        return fake;
      };

      applyMock.mockImplementation(({ queryBuilder }) => {
        queryBuilder.scoped = true;
      });

      const child = buildRepository();

      Object.assign((child as any).options, {
        flatObjectMetadata: { nameSingular: 'noteTarget' },
        getRepositoryForObjectMetadataId: () => parentRepository,
      });
      (child as any).shouldValidateInheritedParents = () => true;
      (child as any).resolveInheritingRecordLinks = () => [];
      (child as any).resolveOwnParentLinks = () => [
        {
          joinColumnName: 'companyId',
          parentFlatObjectMetadata: {
            id: 'company-id',
            nameSingular: 'company',
          },
        },
      ];

      return child;
    };

    const attachChildTo = (parentId: string) =>
      (
        buildChildRepository() as any
      ).validateInheritedParentsAreWritableOrThrow({
        writtenRecords: [{ companyId: parentId }],
        affectedRecords: [],
      });

    afterEach(() => {
      applyMock.mockReset();
    });

    it('a scoped member attaching a child under an IN-scope parent succeeds', async () => {
      await expect(attachChildTo(IN_SCOPE_PARENT)).resolves.toBeUndefined();
    });

    it('a scoped member attaching a child under an OUT-of-scope parent is refused', async () => {
      const attempt = attachChildTo(OUT_OF_SCOPE_PARENT);

      await expect(attempt).rejects.toBeInstanceOf(PermissionsException);
      await expect(attempt).rejects.toMatchObject({
        code: PermissionsExceptionCode.PERMISSION_DENIED,
      });
    });
  });

  // 🔴 L'UNIQUE lecture qui lève le filtre, et elle ne lève que lui. Défaut du
  // 2026-09-24 : la relecture d'une création passait par le filtre avant que
  // `scopePath` soit posé, rendait 0 ligne, et le membre cloisonné recevait une erreur
  // sur une note pourtant écrite.
  describe('RELECTURE DE SES PROPRES INSERTIONS — onBeforeExecuteOwnInserts', () => {
    it('ne pose PAS le filtre de portée, mais garde les permissions d objet et de champ', () => {
      const repository = buildRepository();
      const rowLevel = jest.fn();
      const validate = jest.fn();

      (repository as any).applyRowLevelPermissionPredicates = rowLevel;
      (repository as any).validateQueryIsPermitted = validate;

      (repository as any).onBeforeExecuteOwnInserts(buildQueryBuilder());

      expect(applyMock).not.toHaveBeenCalled();
      expect(rowLevel).toHaveBeenCalledTimes(1);
      expect(validate).toHaveBeenCalledTimes(1);
    });
  });
});
