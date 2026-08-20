import { Test, type TestingModule } from '@nestjs/testing';

import { CountryScopeService } from 'src/engine/core-modules/country-scope/services/country-scope.service';
import { NavigateAppTool } from 'src/engine/core-modules/tool/tools/navigate-tool/navigate-app-tool';
import { NavigationMenuItemService } from 'src/engine/metadata-modules/navigation-menu-item/navigation-menu-item.service';
import { WorkspaceManyOrAllFlatEntityMapsCacheService } from 'src/engine/metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service';
import { ViewService } from 'src/engine/metadata-modules/view/services/view.service';
import { GlobalWorkspaceOrmManager } from 'src/engine/twenty-orm/global-workspace-datasource/global-workspace-orm.manager';

// `navigateToRecord` lit TOUS les enregistrements de l'objet en bypass de permissions et en
// contexte système : ni les permissions object-level ni le filtre de portée ne s'y appliquent,
// et l'outil est exposé sans flag de permission. Le périmètre y est donc posé à la main, et
// c'est ce que vérifie ce test — un enregistrement hors périmètre ne doit pas être trouvable.
describe('NavigateAppTool — périmètre sur navigateToRecord', () => {
  let tool: NavigateAppTool;

  const find = jest.fn();
  const resolveScopeForUser = jest.fn();

  // Objet `company` portant un libellé `name`, un `scopePath` et un `countryCode` — la
  // forme du workspace réel. Forme canonique des flat maps :
  // fieldIds -> universalIdentifierById -> byUniversalIdentifier.
  const flatMaps = {
    flatObjectMetadataMaps: {
      byUniversalIdentifier: {
        'company-uid': {
          nameSingular: 'company',
          isActive: true,
          labelIdentifierFieldMetadataId: 'name-field-id',
          fieldIds: ['name-field-id', 'sp-field-id', 'cc-field-id'],
        },
      },
    },
    flatFieldMetadataMaps: {
      universalIdentifierById: {
        'name-field-id': 'name-uid',
        'sp-field-id': 'sp-uid',
        'cc-field-id': 'cc-uid',
      },
      byUniversalIdentifier: {
        'name-uid': { id: 'name-field-id', name: 'name', type: 'TEXT' },
        'sp-uid': { id: 'sp-field-id', name: 'scopePath', type: 'TEXT' },
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
      kind: 'tokens',
      allowed: ['c:CI'],
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
      kind: 'tokens',
      allowed: ['c:CI'],
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

  it('sélectionne les champs de portée pour pouvoir filtrer quand le membre est cloisonné', async () => {
    resolveScopeForUser.mockResolvedValue({
      kind: 'tokens',
      allowed: ['c:CI'],
    });
    find.mockResolvedValue([]);

    await navigateToRecord('peu importe');

    // ⚠️ Sans ces colonnes, le filtre les lit `undefined` et laisse tout passer.
    expect(find).toHaveBeenCalledWith({
      select: ['id', 'name', 'scopePath', 'countryCode'],
    });
  });

  it('ne filtre rien et ne lit aucun champ de portée pour un membre non cloisonné', async () => {
    resolveScopeForUser.mockResolvedValue({ kind: 'unscoped' });
    find.mockResolvedValue([
      { id: 'company-co', name: 'Polimeros Andinos', countryCode: 'CO' },
    ]);

    const result = await navigateToRecord('Polimeros Andinos');

    expect(find).toHaveBeenCalledWith({ select: ['id', 'name'] });
    expect(result.success).toBe(true);
  });
  // --- Portefeuille (lot B2). Le périmètre du membre est une liste de jetons ; le pays
  // n'est plus qu'un jeton parmi d'autres, et le repli quand l'enregistrement n'a pas de
  // portée écrite.

  it('ne trouve pas une société d un autre groupe du MÊME pays', async () => {
    // La régression que le lot B2 corrige : sous le filtre pays, `company-autre` était
    // visible parce que le pays suffisait.
    resolveScopeForUser.mockResolvedValue({
      kind: 'tokens',
      allowed: ['g:217', 'c:CI'],
    });
    find.mockResolvedValue([
      {
        id: 'company-autre',
        name: 'Abidjan Polymers',
        scopePath: '|g:260|',
        countryCode: 'CI',
      },
    ]);

    const result = await navigateToRecord('Abidjan Polymers');

    expect(result.success).toBe(false);
    expect(find).toHaveBeenCalled();
  });

  it('trouve une société portée par plusieurs groupes dont un des miens', async () => {
    resolveScopeForUser.mockResolvedValue({
      kind: 'tokens',
      allowed: ['g:217'],
    });
    find.mockResolvedValue([
      {
        id: 'company-partagee',
        name: 'Abidjan Plastiques',
        scopePath: '|g:217|g:260|',
        countryCode: 'CI',
      },
    ]);

    const result = await navigateToRecord('Abidjan Plastiques');

    expect(result.success).toBe(true);
    expect(result.result).toEqual({
      action: 'navigateToRecord',
      objectNameSingular: 'company',
      recordId: 'company-partagee',
    });
  });

  it('retombe sur le pays quand la société n a pas encore de scopePath', async () => {
    // 4112 enregistrements du workspace sont dans ce cas au 2026-08-19.
    resolveScopeForUser.mockResolvedValue({
      kind: 'tokens',
      allowed: ['g:217', 'c:CI'],
    });
    find.mockResolvedValue([
      {
        id: 'company-sans-portee',
        name: 'Abidjan Chimie',
        scopePath: '',
        countryCode: 'CI',
      },
    ]);

    const result = await navigateToRecord('Abidjan Chimie');

    expect(result.success).toBe(true);
  });
});
