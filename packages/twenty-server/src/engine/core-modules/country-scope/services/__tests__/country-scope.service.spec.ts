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

      await expect(resolveScopeForUser('user-id')).resolves.toEqual({
        kind: 'countries',
        allowed: ['CI', 'SN'],
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
        kind: 'countries',
        allowed: [],
      });
    });
  });
});
