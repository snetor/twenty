import { applyCountryPermissionFilter } from 'src/engine/twenty-orm/utils/apply-country-permission-filter.util';
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
    ) => {
      try {
        await (repository as any).runMutation({
          selectQueryBuilder: buildQueryBuilder(),
          rowLevelPermissionsApplied,
          kind: 'update',
          columnsToReturn: ['id'],
          data: { name: 'x' },
        });
      } catch {
        // attendu : l'aval n'est pas branché dans ce test
      }
    };

    it('applique le filtre quand les prédicats ne sont pas déjà posés', async () => {
      const repository = buildRepository();

      (repository as any).applyRowLevelPermissionPredicates = jest.fn();

      await runMutationIgnoringDownstream(repository, false);

      expect(applyMock).toHaveBeenCalledTimes(1);
    });

    it('ne l applique pas deux fois quand ils le sont déjà', async () => {
      const repository = buildRepository();

      (repository as any).applyRowLevelPermissionPredicates = jest.fn();

      // `rowLevelPermissionsApplied: true` signifie que l'appelant a déjà déclenché
      // `onBeforeExecute`, qui a donc déjà posé notre filtre. Le ré-appliquer
      // dupliquerait la condition. La condition est celle de l'amont, et c'est ce
      // qui la rend juste : les deux prédicats suivent exactement le même cycle.
      await runMutationIgnoringDownstream(repository, true);

      expect(applyMock).not.toHaveBeenCalled();
    });
  });
});
