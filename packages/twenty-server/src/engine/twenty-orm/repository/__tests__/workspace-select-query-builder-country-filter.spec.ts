import { WorkspaceSelectQueryBuilder } from 'src/engine/twenty-orm/repository/workspace-select-query-builder';
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

// Test ciblé du branchement du filtre pays au choke-point `validatePermissions()`.
// On construit l'instance sans passer par super() (qui exige une connexion DataSource) :
// le predicat ne touche qu'aux propriétés posées à la main.
const buildQb = (overrides: Record<string, unknown>) => {
  const qb = Object.create(
    WorkspaceSelectQueryBuilder.prototype,
  ) as WorkspaceSelectQueryBuilder<any>;

  Object.assign(qb, {
    internalContext: { objectIdByNameSingular: {} } as any,
    authContext: { type: 'user', workspaceMember: { allowedCountries: 'ES' } } as any,
    shouldBypassPermissionChecks: false,
    expressionMap: { mainAlias: { target: 'company', subQuery: false } } as any,
    ...overrides,
  });

  return qb;
};

const callPredicate = (qb: WorkspaceSelectQueryBuilder<any>) =>
  (qb as any).applyCountryPermissionFilterPredicate();

describe('WorkspaceSelectQueryBuilder — branchement du filtre pays', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getMetadataMock.mockReturnValue({ nameSingular: 'company', fieldIds: [] } as any);
    applyMock.mockImplementation(() => undefined);
  });

  it('appelle applyCountryPermissionFilter pour une lecture normale', () => {
    callPredicate(buildQb({}));

    expect(applyMock).toHaveBeenCalledTimes(1);
  });

  it("ne filtre pas quand shouldBypassPermissionChecks=true", () => {
    callPredicate(buildQb({ shouldBypassPermissionChecks: true }));

    expect(applyMock).not.toHaveBeenCalled();
  });

  it('ne filtre pas une subquery (pas de metadata)', () => {
    callPredicate(
      buildQb({
        expressionMap: { mainAlias: { target: 'company', subQuery: true } } as any,
      }),
    );

    expect(applyMock).not.toHaveBeenCalled();
  });
});
