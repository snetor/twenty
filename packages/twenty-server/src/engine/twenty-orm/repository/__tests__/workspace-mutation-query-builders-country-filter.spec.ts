import { WorkspaceDeleteQueryBuilder } from 'src/engine/twenty-orm/repository/workspace-delete-query-builder';
import { WorkspaceSoftDeleteQueryBuilder } from 'src/engine/twenty-orm/repository/workspace-soft-delete-query-builder';
import { WorkspaceUpdateQueryBuilder } from 'src/engine/twenty-orm/repository/workspace-update-query-builder';
import { applyCountryPermissionFilter } from 'src/engine/twenty-orm/utils/apply-country-permission-filter.util';
import { getObjectMetadataFromEntityTarget } from 'src/engine/twenty-orm/utils/get-object-metadata-from-entity-target.util';

// SWC compile les exports ESM en getters non-configurables → `jest.spyOn` lève
// "Cannot redefine property". On remplace donc les modules par des factories mockées.
jest.mock(
  'src/engine/twenty-orm/utils/apply-country-permission-filter.util',
  () => ({ applyCountryPermissionFilter: jest.fn() }),
);
jest.mock(
  'src/engine/twenty-orm/utils/get-object-metadata-from-entity-target.util',
  () => ({ getObjectMetadataFromEntityTarget: jest.fn() }),
);

const applyMock = applyCountryPermissionFilter as jest.Mock;
const getMetadataMock = getObjectMetadataFromEntityTarget as jest.Mock;

// 🔴 Le cloisonnement par portefeuille était un filtre de LECTURE seulement : les trois
// constructeurs de mutation n'appelaient que le prédicat row-level upstream, et le chemin
// de mutation ne fait aucune relecture filtrée (`UPDATE … RETURNING` sans SELECT). Un
// utilisateur qui connaissait un `id` hors de son périmètre écrivait dessus. Ces tests
// gardent le branchement, pas la forme du prédicat — celle-ci est couverte par
// `utils/__tests__/apply-country-permission-filter.util.spec.ts`.
//
// On construit les instances sans passer par super() (qui exige une connexion DataSource) :
// le prédicat ne touche qu'aux propriétés posées à la main.
// oxlint-disable-next-line typescript/no-explicit-any
const BUILDERS: [string, any, string][] = [
  ['WorkspaceUpdateQueryBuilder', WorkspaceUpdateQueryBuilder, 'update'],
  ['WorkspaceDeleteQueryBuilder', WorkspaceDeleteQueryBuilder, 'delete'],
  [
    'WorkspaceSoftDeleteQueryBuilder',
    WorkspaceSoftDeleteQueryBuilder,
    'soft-delete',
  ],
];

const buildQb = (
  // oxlint-disable-next-line typescript/no-explicit-any
  Builder: any,
  queryType: string,
  overrides: Record<string, unknown> = {},
  // oxlint-disable-next-line typescript/no-explicit-any
): any => {
  const qb = Object.create(Builder.prototype);

  Object.assign(qb, {
    internalContext: { objectIdByNameSingular: {} },
    authContext: {
      type: 'user',
      workspaceMember: { allowedScopes: 'g:217' },
    },
    shouldBypassPermissionChecks: false,
    expressionMap: { mainAlias: { target: 'company' }, queryType },
    ...overrides,
  });

  return qb;
};

// oxlint-disable-next-line typescript/no-explicit-any
const callPredicate = (qb: any) => qb.applyCountryPermissionFilterPredicate();

describe.each(BUILDERS)(
  '%s — branchement du cloisonnement en écriture',
  (_name, Builder, queryType) => {
    beforeEach(() => {
      getMetadataMock.mockReturnValue({
        nameSingular: 'company',
        fieldIds: [],
      });
      applyMock.mockImplementation(() => undefined);
    });

    it('rappelle applyCountryPermissionFilter sur la mutation', () => {
      const qb = buildQb(Builder, queryType);

      callPredicate(qb);

      expect(applyMock).toHaveBeenCalledTimes(1);
      expect(applyMock.mock.calls[0][0]).toMatchObject({
        queryBuilder: qb,
        authContext: qb.authContext,
      });
    });

    // ⚠️ Même porte de sortie qu'en lecture : c'est par elle que passent l'ingestion,
    // le rapport de visite et les passes SAP, qui écrivent hors de tout périmètre.
    it('ne filtre pas quand shouldBypassPermissionChecks=true', () => {
      callPredicate(
        buildQb(Builder, queryType, { shouldBypassPermissionChecks: true }),
      );

      expect(applyMock).not.toHaveBeenCalled();
    });
  },
);
