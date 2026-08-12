import { Test, type TestingModule } from '@nestjs/testing';

import { CountryScopeService } from 'src/engine/core-modules/country-scope/services/country-scope.service';
import { NavigateAppTool } from 'src/engine/core-modules/tool/tools/navigate-tool/navigate-app-tool';
import { NavigationMenuItemService } from 'src/engine/metadata-modules/navigation-menu-item/navigation-menu-item.service';
import { WorkspaceManyOrAllFlatEntityMapsCacheService } from 'src/engine/metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service';
import { ViewService } from 'src/engine/metadata-modules/view/services/view.service';
import { GlobalWorkspaceOrmManager } from 'src/engine/twenty-orm/global-workspace-datasource/global-workspace-orm.manager';

// `navigateToRecord` lit TOUS les enregistrements de l'objet en bypass de permissions et en
// contexte système : ni les permissions object-level ni le filtre pays ne s'y appliquent, et
// l'outil est exposé sans flag de permission. Le périmètre pays y est donc posé à la main, et
// c'est ce que vérifie ce test — un enregistrement hors périmètre ne doit pas être trouvable.
describe('NavigateAppTool — périmètre pays sur navigateToRecord', () => {
  let tool: NavigateAppTool;

  const find = jest.fn();
  const resolveScopeForUser = jest.fn();

  // Objet `company` portant un libellé `name` et un `countryCode`. Forme canonique des
  // flat maps : fieldIds -> universalIdentifierById -> byUniversalIdentifier.
  const flatMaps = {
    flatObjectMetadataMaps: {
      byUniversalIdentifier: {
        'company-uid': {
          nameSingular: 'company',
          isActive: true,
          labelIdentifierFieldMetadataId: 'name-field-id',
          fieldIds: ['name-field-id', 'cc-field-id'],
        },
      },
    },
    flatFieldMetadataMaps: {
      universalIdentifierById: {
        'name-field-id': 'name-uid',
        'cc-field-id': 'cc-uid',
      },
      byUniversalIdentifier: {
        'name-uid': { id: 'name-field-id', name: 'name', type: 'TEXT' },
        'cc-uid': { id: 'cc-field-id', name: 'countryCode', type: 'TEXT' },
      },
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NavigateAppTool,
        { provide: NavigationMenuItemService, useValue: {} },
        { provide: ViewService, useValue: {} },
        {
          provide: WorkspaceManyOrAllFlatEntityMapsCacheService,
          useValue: {
            getOrRecomputeManyOrAllFlatEntityMaps: jest
              .fn()
              .mockResolvedValue(flatMaps),
          },
        },
        {
          provide: GlobalWorkspaceOrmManager,
          useValue: {
            getRepository: jest.fn().mockResolvedValue({ find }),
            executeInWorkspaceContext: jest
              .fn()
              .mockImplementation((callback: () => unknown) => callback()),
          },
        },
        { provide: CountryScopeService, useValue: { resolveScopeForUser } },
      ],
    }).compile();

    tool = module.get<NavigateAppTool>(NavigateAppTool);
  });

  // Depuis la v2.30, l'entrée de l'outil est imbriquée sous `navigation`.
  const navigateToRecord = (recordName: string) =>
    tool.execute(
      {
        navigation: {
          type: 'navigateToRecord',
          objectNameSingular: 'company',
          recordName,
        },
      },
      { workspaceId: 'workspace-id', userId: 'user-id' },
    );

  it('ne trouve pas une société hors du périmètre du membre', async () => {
    resolveScopeForUser.mockResolvedValue({
      kind: 'countries',
      allowed: ['CI'],
    });
    find.mockResolvedValue([
      { id: 'company-co', name: 'Polimeros Andinos', countryCode: 'CO' },
    ]);

    const result = await navigateToRecord('Polimeros Andinos');

    expect(result.success).toBe(false);
    expect(result.result).toBeUndefined();
    // Garde-fou : l'échec doit venir du filtrage, pas d'une entrée rejetée en amont.
    expect(find).toHaveBeenCalled();
  });

  it('trouve une société du périmètre et rend son id', async () => {
    resolveScopeForUser.mockResolvedValue({
      kind: 'countries',
      allowed: ['CI'],
    });
    find.mockResolvedValue([
      { id: 'company-ci', name: 'Abidjan Plastiques', countryCode: 'CI' },
      { id: 'company-co', name: 'Polimeros Andinos', countryCode: 'CO' },
    ]);

    const result = await navigateToRecord('Abidjan Plastiques');

    expect(result.success).toBe(true);
    expect(result.result).toEqual({
      action: 'navigateToRecord',
      objectNameSingular: 'company',
      recordId: 'company-ci',
    });
  });

  it('sélectionne countryCode pour pouvoir filtrer quand le membre est cloisonné', async () => {
    resolveScopeForUser.mockResolvedValue({
      kind: 'countries',
      allowed: ['CI'],
    });
    find.mockResolvedValue([]);

    await navigateToRecord('peu importe');

    expect(find).toHaveBeenCalledWith({
      select: ['id', 'name', 'countryCode'],
    });
  });

  it('ne filtre rien et ne lit pas countryCode pour un membre non cloisonné', async () => {
    resolveScopeForUser.mockResolvedValue({ kind: 'unscoped' });
    find.mockResolvedValue([
      { id: 'company-co', name: 'Polimeros Andinos', countryCode: 'CO' },
    ]);

    const result = await navigateToRecord('Polimeros Andinos');

    expect(find).toHaveBeenCalledWith({ select: ['id', 'name'] });
    expect(result.success).toBe(true);
  });
});
