import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';

import { type ObjectRecordCreateEvent } from 'twenty-shared/database-events';

import { ScopeAssignmentListener } from 'src/engine/core-modules/country-scope/listeners/scope-assignment.listener';
import { GlobalWorkspaceOrmManager } from 'src/engine/twenty-orm/global-workspace-datasource/global-workspace-orm.manager';
import { type WorkspaceEventBatch } from 'src/engine/workspace-event-emitter/types/workspace-event-batch.type';

describe('ScopeAssignmentListener', () => {
  let listener: ScopeAssignmentListener;

  const workspaceMemberRepository = { update: jest.fn() };
  const salespersonRepository = { findOne: jest.fn() };
  const getRepository = jest.fn();

  beforeEach(async () => {
    jest.clearAllMocks();

    getRepository.mockImplementation(
      (_workspaceId: string, entityName: string) =>
        Promise.resolve(
          entityName === 'workspaceMember'
            ? workspaceMemberRepository
            : salespersonRepository,
        ),
    );

    const mockGlobalWorkspaceOrmManager = {
      getRepository,
      executeInWorkspaceContext: jest
        .fn()
        .mockImplementation((callback: () => unknown) => callback()),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScopeAssignmentListener,
        {
          provide: GlobalWorkspaceOrmManager,
          useValue: mockGlobalWorkspaceOrmManager,
        },
      ],
    }).compile();

    listener = module.get<ScopeAssignmentListener>(ScopeAssignmentListener);
  });

  const batchOf = (
    members: { id: string; userEmail: string | null }[],
  ): WorkspaceEventBatch<ObjectRecordCreateEvent<never>> =>
    ({
      workspaceId: 'workspace-id',
      events: members.map((after) => ({ properties: { after } })),
    }) as unknown as WorkspaceEventBatch<ObjectRecordCreateEvent<never>>;

  it('écrit allowedScopes depuis les scopeTokens du salesperson du même mail', async () => {
    salespersonRepository.findOne.mockResolvedValue({
      id: 'sp-1',
      email: 'c.ribeiro@snetor.com',
      scopeTokens: 'g:131,g:229',
    });

    await listener.handleCreate(
      batchOf([{ id: 'wm-1', userEmail: 'c.ribeiro@snetor.com' }]),
    );

    expect(workspaceMemberRepository.update).toHaveBeenCalledWith('wm-1', {
      allowedScopes: 'g:131,g:229',
    });
  });

  it('rapproche le mail sans tenir compte de la casse', async () => {
    salespersonRepository.findOne.mockResolvedValue({
      id: 'sp-1',
      email: 'c.ribeiro@snetor.com',
      scopeTokens: 'g:131',
    });

    await listener.handleCreate(
      batchOf([{ id: 'wm-1', userEmail: 'C.Ribeiro@Snetor.com' }]),
    );

    expect(workspaceMemberRepository.update).toHaveBeenCalledWith('wm-1', {
      allowedScopes: 'g:131',
    });
  });

  it("n'écrit rien et journalise un warn si aucun salesperson ne porte ce mail", async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    salespersonRepository.findOne.mockResolvedValue(null);

    await listener.handleCreate(
      batchOf([{ id: 'wm-1', userEmail: 'inconnu@snetor.com' }]),
    );

    expect(workspaceMemberRepository.update).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("n'écrit rien si le salesperson existe mais que scopeTokens est vide", async () => {
    salespersonRepository.findOne.mockResolvedValue({
      id: 'sp-1',
      email: 'vide@snetor.com',
      scopeTokens: '   ',
    });

    await listener.handleCreate(
      batchOf([{ id: 'wm-1', userEmail: 'vide@snetor.com' }]),
    );

    expect(workspaceMemberRepository.update).not.toHaveBeenCalled();
  });

  it("n'écrit rien pour un membre sans userEmail", async () => {
    await listener.handleCreate(batchOf([{ id: 'wm-1', userEmail: null }]));

    expect(salespersonRepository.findOne).not.toHaveBeenCalled();
    expect(workspaceMemberRepository.update).not.toHaveBeenCalled();
  });

  it("ne casse JAMAIS la connexion : un workspace sans l'objet salesperson est un non-événement", async () => {
    // Un workspace neuf, ou un workspace de test, ne porte pas les objets custom Snetor.
    // `getRepository('salesperson')` y lève. Comme le membre naît au premier login, laisser
    // cette exception remonter casse la connexion elle-même.
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    getRepository.mockImplementation(
      (_workspaceId: string, entityName: string) =>
        entityName === 'salesperson'
          ? Promise.reject(new Error('object metadata not found: salesperson'))
          : Promise.resolve(workspaceMemberRepository),
    );

    await expect(
      listener.handleCreate(
        batchOf([{ id: 'wm-1', userEmail: 'c.ribeiro@snetor.com' }]),
      ),
    ).resolves.toBeUndefined();

    expect(workspaceMemberRepository.update).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("traite tout le lot : l'échec d'un membre ne prive pas les autres de leur périmètre", async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();

    salespersonRepository.findOne.mockImplementation(
      ({ where }: { where: { email: { value: string } | string } }) => {
        const email = String(
          typeof where.email === 'string' ? where.email : where.email.value,
        ).toLowerCase();

        if (email === 'casse@snetor.com') {
          return Promise.reject(new Error('boom'));
        }

        return Promise.resolve({ email, scopeTokens: `g:${email[0]}` });
      },
    );

    await listener.handleCreate(
      batchOf([
        { id: 'wm-1', userEmail: 'a@snetor.com' },
        { id: 'wm-2', userEmail: 'casse@snetor.com' },
        { id: 'wm-3', userEmail: 'b@snetor.com' },
      ]),
    );

    expect(workspaceMemberRepository.update).toHaveBeenCalledWith('wm-1', {
      allowedScopes: 'g:a',
    });
    expect(workspaceMemberRepository.update).toHaveBeenCalledWith('wm-3', {
      allowedScopes: 'g:b',
    });
    expect(workspaceMemberRepository.update).toHaveBeenCalledTimes(2);
  });
});
