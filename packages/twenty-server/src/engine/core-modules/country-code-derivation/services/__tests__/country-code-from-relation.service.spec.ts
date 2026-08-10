import { Test, type TestingModule } from '@nestjs/testing';

import { CountryCodeFromRelationService } from 'src/engine/core-modules/country-code-derivation/services/country-code-from-relation.service';
import { WorkspaceManyOrAllFlatEntityMapsCacheService } from 'src/engine/metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service';
import { GlobalWorkspaceOrmManager } from 'src/engine/twenty-orm/global-workspace-datasource/global-workspace-orm.manager';

const WORKSPACE_ID = 'ws-1';
const COUNTRY_ID = 'ctry-1';
const COMPANY_ID = 'cmp-1';

// Le service ne consulte les flat maps que pour savoir si l'objet porte `countryCode`.
// On les stube au minimum : un objet `company` et un objet `person`, chacun avec le champ.
const flatMaps = () => ({
  flatObjectMetadataMaps: {
    byId: {
      'obj-company': {
        id: 'obj-company',
        nameSingular: 'company',
        fieldMetadataIds: ['fld-cc-company'],
      },
      'obj-person': {
        id: 'obj-person',
        nameSingular: 'person',
        fieldMetadataIds: ['fld-cc-person'],
      },
    },
    idByNameSingular: { company: 'obj-company', person: 'obj-person' },
  },
  flatFieldMetadataMaps: {
    byId: {
      'fld-cc-company': { id: 'fld-cc-company', name: 'countryCode' },
      'fld-cc-person': { id: 'fld-cc-person', name: 'countryCode' },
    },
  },
});

describe('CountryCodeFromRelationService', () => {
  let service: CountryCodeFromRelationService;
  let getRepository: jest.Mock;
  const authContext = { workspace: { id: WORKSPACE_ID } } as never;

  beforeEach(async () => {
    getRepository = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CountryCodeFromRelationService,
        {
          provide: GlobalWorkspaceOrmManager,
          useValue: {
            getRepository,
            // On exécute la closure telle quelle : le contexte ORM n'est pas testé ici.
            executeInWorkspaceContext: (fn: () => unknown) => fn(),
          },
        },
        {
          provide: WorkspaceManyOrAllFlatEntityMapsCacheService,
          useValue: {
            getOrRecomputeManyOrAllFlatEntityMaps: jest
              .fn()
              .mockResolvedValue(flatMaps()),
          },
        },
      ],
    }).compile();

    service = module.get(CountryCodeFromRelationService);
  });

  it('résout le pays en lecture système et pose countryCode (chemin self)', async () => {
    getRepository.mockResolvedValue({
      find: jest.fn().mockResolvedValue([{ id: COUNTRY_ID, isoCode: 'ng' }]),
    });

    const [record] = await service.injectCountryCode({
      records: [{ name: 'ACME', countryId: COUNTRY_ID }],
      objectMetadataNameSingular: 'company',
      authContext,
    });

    expect(record.countryCode).toBe('NG');
  });

  // Régression : sans bypass, la lecture du référentiel est refusée par le choke-point ORM
  // (« Entity performing the request does not have permission »), le catch avale l'erreur,
  // countryCode reste vide et l'enregistrement naît invisible. Constaté en DEV le 2026-08-10
  // sur l'image v2.9.4-snetor.5 : le module était déployé et sans aucun effet.
  it('lit le référentiel pays en bypass de permissions', async () => {
    getRepository.mockResolvedValue({
      find: jest.fn().mockResolvedValue([{ id: COUNTRY_ID, isoCode: 'NG' }]),
    });

    await service.injectCountryCode({
      records: [{ countryId: COUNTRY_ID }],
      objectMetadataNameSingular: 'company',
      authContext,
    });

    expect(getRepository).toHaveBeenCalledWith(WORKSPACE_ID, 'country', {
      shouldBypassPermissionChecks: true,
    });
  });

  it('lit la company parente en bypass de permissions (chemin parent)', async () => {
    getRepository.mockResolvedValue({
      find: jest.fn().mockResolvedValue([{ id: COMPANY_ID, countryCode: 'NG' }]),
    });

    const [record] = await service.injectCountryCode({
      records: [{ companyId: COMPANY_ID }],
      objectMetadataNameSingular: 'person',
      authContext,
    });

    expect(getRepository).toHaveBeenCalledWith(WORKSPACE_ID, 'company', {
      shouldBypassPermissionChecks: true,
    });
    expect(record.countryCode).toBe('NG');
  });

  it("n'écrit rien et ne lève pas si la lecture échoue", async () => {
    getRepository.mockRejectedValue(new Error('boom'));

    const [record] = await service.injectCountryCode({
      records: [{ countryId: COUNTRY_ID }],
      objectMetadataNameSingular: 'company',
      authContext,
    });

    expect(record.countryCode).toBeUndefined();
  });

  it('ne touche pas un objet hors périmètre de cloisonnement', async () => {
    const [record] = await service.injectCountryCode({
      records: [{ countryId: COUNTRY_ID }],
      objectMetadataNameSingular: 'workspaceMember',
      authContext,
    });

    expect(getRepository).not.toHaveBeenCalled();
    expect(record.countryCode).toBeUndefined();
  });
});
