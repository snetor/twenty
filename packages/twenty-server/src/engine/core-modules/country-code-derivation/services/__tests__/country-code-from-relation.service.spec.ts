import { CountryCodeFromRelationService } from 'src/engine/core-modules/country-code-derivation/services/country-code-from-relation.service';

const WORKSPACE_ID = 'ws-1';
const COUNTRY_ID = 'ctry-1';
const COMPANY_ID = 'cmp-1';
const SYSTEM_READ = { shouldBypassPermissionChecks: true };

const authContext = { workspace: { id: WORKSPACE_ID } } as never;

// Le garde-fou « l'objet porte-t-il countryCode » lit les flat maps et a ses
// propres concerns ; il est stubé pour que ces tests portent uniquement sur la
// résolution en base et sa configuration de permissions. Le stub évite aussi de
// coupler la suite à la forme interne des flat maps, qui bouge en amont.
const buildService = (find: jest.Mock) => {
  const getRepository = jest.fn().mockResolvedValue({ find });
  const service = new CountryCodeFromRelationService(
    {
      getRepository,
      executeInWorkspaceContext: (fn: () => unknown) => fn(),
    } as never,
    {} as never,
  );

  jest
    .spyOn(
      service as unknown as {
        objectHasCountryCodeField: () => Promise<boolean>;
      },
      'objectHasCountryCodeField',
    )
    .mockResolvedValue(true);

  return { service, getRepository };
};

describe('CountryCodeFromRelationService', () => {
  // Régression : sans bypass, la lecture du référentiel est refusée par le
  // choke-point ORM (« Entity performing the request does not have permission »),
  // le catch avale l'erreur, countryCode reste vide et l'enregistrement naît
  // invisible pour tout le monde. Constaté en DEV le 2026-08-10 sur l'image
  // v2.9.4-snetor.5 : le module était déployé et sans aucun effet.
  it('résout le pays en lecture système et pose countryCode', async () => {
    const find = jest
      .fn()
      .mockResolvedValue([{ id: COUNTRY_ID, isoCode: 'ng' }]);
    const { service, getRepository } = buildService(find);

    const [record] = await service.injectCountryCode({
      records: [{ name: 'ACME', countryId: COUNTRY_ID }],
      objectMetadataNameSingular: 'company',
      authContext,
    });

    expect(getRepository).toHaveBeenCalledWith(
      WORKSPACE_ID,
      'country',
      SYSTEM_READ,
    );
    expect(record.countryCode).toBe('NG');
  });

  it('hérite du countryCode de la company parente en lecture système', async () => {
    const find = jest
      .fn()
      .mockResolvedValue([{ id: COMPANY_ID, countryCode: 'NG' }]);
    const { service, getRepository } = buildService(find);

    const [record] = await service.injectCountryCode({
      records: [{ companyId: COMPANY_ID }],
      objectMetadataNameSingular: 'person',
      authContext,
    });

    expect(getRepository).toHaveBeenCalledWith(
      WORKSPACE_ID,
      'company',
      SYSTEM_READ,
    );
    expect(record.countryCode).toBe('NG');
  });

  it("n'écrit rien et ne lève pas si la lecture échoue", async () => {
    const find = jest.fn().mockRejectedValue(new Error('boom'));
    const { service } = buildService(find);

    const [record] = await service.injectCountryCode({
      records: [{ countryId: COUNTRY_ID }],
      objectMetadataNameSingular: 'company',
      authContext,
    });

    expect(record.countryCode).toBeUndefined();
  });

  it('ne lit rien pour un objet hors périmètre de cloisonnement', async () => {
    const find = jest.fn();
    const { service, getRepository } = buildService(find);

    const [record] = await service.injectCountryCode({
      records: [{ countryId: COUNTRY_ID }],
      objectMetadataNameSingular: 'workspaceMember',
      authContext,
    });

    expect(getRepository).not.toHaveBeenCalled();
    expect(record.countryCode).toBeUndefined();
  });

  it("ne lit rien quand aucune FK n'est fournie", async () => {
    const find = jest.fn();
    const { service, getRepository } = buildService(find);

    await service.injectCountryCode({
      records: [{ name: 'ACME' }],
      objectMetadataNameSingular: 'company',
      authContext,
    });

    expect(getRepository).not.toHaveBeenCalled();
  });
});
