import { Test, type TestingModule } from '@nestjs/testing';

import { CountryScopeService } from 'src/engine/core-modules/country-scope/services/country-scope.service';
import { GlobalWorkspaceOrmManager } from 'src/engine/twenty-orm/global-workspace-datasource/global-workspace-orm.manager';

describe('CountryScopeService', () => {
  let service: CountryScopeService;

  const workspaceMemberRepository = { findOne: jest.fn() };
  const personRepository = { find: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();

    const mockGlobalWorkspaceOrmManager = {
      getRepository: jest
        .fn()
        .mockImplementation((_workspaceId: string, entityName: string) =>
          Promise.resolve(
            entityName === 'workspaceMember'
              ? workspaceMemberRepository
              : personRepository,
          ),
        ),
      executeInWorkspaceContext: jest
        .fn()
        .mockImplementation((callback: () => unknown) => callback()),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CountryScopeService,
        {
          provide: GlobalWorkspaceOrmManager,
          useValue: mockGlobalWorkspaceOrmManager,
        },
      ],
    }).compile();

    service = module.get<CountryScopeService>(CountryScopeService);
  });

  const keepPersonIdsInScope = (personIds: string[]) =>
    service.keepPersonIdsInScope({
      personIds,
      workspaceMemberId: 'workspace-member-id',
      workspaceId: 'workspace-id',
    });

  it('rend la liste inchangée si le champ allowedCountries est absent (workspace non cloisonné)', async () => {
    workspaceMemberRepository.findOne.mockResolvedValue({
      id: 'workspace-member-id',
    });

    await expect(keepPersonIdsInScope(['p1', 'p2'])).resolves.toEqual([
      'p1',
      'p2',
    ]);
    expect(personRepository.find).not.toHaveBeenCalled();
  });

  it('rend la liste inchangée pour un membre « tous pays »', async () => {
    workspaceMemberRepository.findOne.mockResolvedValue({
      id: 'workspace-member-id',
      allowedCountries: '*',
    });

    await expect(keepPersonIdsInScope(['p1'])).resolves.toEqual(['p1']);
    expect(personRepository.find).not.toHaveBeenCalled();
  });

  it('ne garde que les personnes dont le countryCode est dans le périmètre', async () => {
    workspaceMemberRepository.findOne.mockResolvedValue({
      id: 'workspace-member-id',
      allowedCountries: 'CI;SN',
    });
    personRepository.find.mockResolvedValue([
      { id: 'p-ci', countryCode: 'CI' },
      { id: 'p-co', countryCode: 'CO' },
      { id: 'p-sans-pays', countryCode: null },
    ]);

    await expect(
      keepPersonIdsInScope(['p-ci', 'p-co', 'p-sans-pays']),
    ).resolves.toEqual(['p-ci']);
  });

  it('rend une liste vide pour un membre sans pays (default-deny)', async () => {
    workspaceMemberRepository.findOne.mockResolvedValue({
      id: 'workspace-member-id',
      allowedCountries: '',
    });
    personRepository.find.mockResolvedValue([
      { id: 'p-ci', countryCode: 'CI' },
    ]);

    await expect(keepPersonIdsInScope(['p-ci'])).resolves.toEqual([]);
  });

  it('rend une liste vide si le membre est introuvable', async () => {
    workspaceMemberRepository.findOne.mockResolvedValue(null);

    await expect(keepPersonIdsInScope(['p1'])).resolves.toEqual([]);
  });

  it('ne lit rien quand la liste d’entrée est vide', async () => {
    await expect(keepPersonIdsInScope([])).resolves.toEqual([]);
    expect(workspaceMemberRepository.findOne).not.toHaveBeenCalled();
  });

  describe('resolveScopeForUser', () => {
    const resolveScopeForUser = (userId: string | undefined) =>
      service.resolveScopeForUser({ userId, workspaceId: 'workspace-id' });

    it('rend unscoped sans userId (exécution sans utilisateur : workflow, job)', async () => {
      await expect(resolveScopeForUser(undefined)).resolves.toEqual({
        kind: 'unscoped',
      });
      expect(workspaceMemberRepository.findOne).not.toHaveBeenCalled();
    });

    it('rend le périmètre du membre correspondant au userId', async () => {
      workspaceMemberRepository.findOne.mockResolvedValue({
        id: 'workspace-member-id',
        allowedCountries: 'CI;SN',
      });

      // Le périmètre pays est désormais rendu en JETONS : `allowedCountries` est le
      // repli de `allowedScopes`, converti par `resolveScope`.
      await expect(resolveScopeForUser('user-id')).resolves.toEqual({
        kind: 'tokens',
        allowed: ['c:CI', 'c:SN'],
      });
    });

    it('rend unscoped pour un membre « tous pays »', async () => {
      workspaceMemberRepository.findOne.mockResolvedValue({
        id: 'workspace-member-id',
        allowedCountries: '*',
      });

      await expect(resolveScopeForUser('user-id')).resolves.toEqual({
        kind: 'unscoped',
      });
    });

    it('default-deny si le membre est introuvable', async () => {
      workspaceMemberRepository.findOne.mockResolvedValue(null);

      await expect(resolveScopeForUser('user-id')).resolves.toEqual({
        kind: 'tokens',
        allowed: [],
      });
    });
  });
  // --- Portefeuille (lot B2). Ce service est le SECOND point d'application : l'onglet
  // Emails et l'agenda s'exécutent en contexte système et échappent au choke-point ORM.
  // Une divergence entre les deux est un trou de sécurité silencieux.

  it('cloisonne par scopePath quand le membre porte un allowedScopes', async () => {
    workspaceMemberRepository.findOne.mockResolvedValue({
      id: 'workspace-member-id',
      allowedScopes: 'g:217',
      allowedCountries: 'EC',
    });
    personRepository.find.mockResolvedValue([
      { id: 'p-mien', scopePath: '|g:217|', countryCode: 'CO' },
      { id: 'p-autre', scopePath: '|g:260|', countryCode: 'EC' },
    ]);

    // Le pays ne sauve pas `p-autre` : c'est bien le portefeuille qui décide dès que
    // l'enregistrement porte une portée.
    await expect(keepPersonIdsInScope(['p-mien', 'p-autre'])).resolves.toEqual([
      'p-mien',
    ]);
  });

  it('garde une personne portée par plusieurs groupes dont un des miens', async () => {
    workspaceMemberRepository.findOne.mockResolvedValue({
      id: 'workspace-member-id',
      allowedScopes: 'g:217',
    });
    personRepository.find.mockResolvedValue([
      { id: 'p1', scopePath: '|g:217|g:260|', countryCode: 'CO' },
    ]);

    await expect(keepPersonIdsInScope(['p1'])).resolves.toEqual(['p1']);
  });

  it('retombe sur le pays quand le membre n a pas encore d allowedScopes', async () => {
    workspaceMemberRepository.findOne.mockResolvedValue({
      id: 'workspace-member-id',
      allowedCountries: 'EC',
    });
    personRepository.find.mockResolvedValue([
      { id: 'p-ec', countryCode: 'EC' },
      { id: 'p-co', countryCode: 'CO' },
    ]);

    await expect(keepPersonIdsInScope(['p-ec', 'p-co'])).resolves.toEqual([
      'p-ec',
    ]);
  });

  // ⚠️ Contrainte liante du 2026-08-19. `scopePath` n'est écrit que sur `company` : les
  // 999 personnes du workspace ont la colonne présente et VIDE. La refuser ferait voir à
  // un commercial ses sociétés et aucun contact.
  it('traite un scopePath vide comme absent, et retombe sur le pays', async () => {
    workspaceMemberRepository.findOne.mockResolvedValue({
      id: 'workspace-member-id',
      allowedScopes: 'g:217,c:EC',
    });
    personRepository.find.mockResolvedValue([
      { id: 'p-vide-ec', scopePath: '', countryCode: 'EC' },
      { id: 'p-vide-co', scopePath: null, countryCode: 'CO' },
    ]);

    await expect(
      keepPersonIdsInScope(['p-vide-ec', 'p-vide-co']),
    ).resolves.toEqual(['p-vide-ec']);
  });

  it('rend la liste inchangée pour un membre non cloisonné par allowedScopes', async () => {
    workspaceMemberRepository.findOne.mockResolvedValue({
      id: 'workspace-member-id',
      allowedScopes: '*',
    });

    await expect(keepPersonIdsInScope(['p1'])).resolves.toEqual(['p1']);
    expect(personRepository.find).not.toHaveBeenCalled();
  });

  it('default-deny : périmètre présent mais vide, aucune personne', async () => {
    workspaceMemberRepository.findOne.mockResolvedValue({
      id: 'workspace-member-id',
      allowedScopes: '',
      allowedCountries: '',
    });
    personRepository.find.mockResolvedValue([
      { id: 'p1', scopePath: '|g:217|', countryCode: 'EC' },
    ]);

    await expect(keepPersonIdsInScope(['p1'])).resolves.toEqual([]);
  });

  it('resolveScopeForUser rend des jetons, pas des ISO pays', async () => {
    // Son consommateur `navigate-app-tool.ts` appelle `isScopeInScope` : rendre un
    // `{ kind: "countries" }` y ferait échouer toute comparaison, en silence.
    workspaceMemberRepository.findOne.mockResolvedValue({
      id: 'workspace-member-id',
      allowedScopes: 'g:217,c:EC',
    });

    await expect(
      service.resolveScopeForUser({
        userId: 'user-id',
        workspaceId: 'workspace-id',
      }),
    ).resolves.toEqual({ kind: 'tokens', allowed: ['g:217', 'c:EC'] });
  });
});
