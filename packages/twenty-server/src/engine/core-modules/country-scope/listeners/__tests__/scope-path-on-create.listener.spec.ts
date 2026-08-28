import { Test, type TestingModule } from '@nestjs/testing';

import { type ObjectRecordCreateEvent } from 'twenty-shared/database-events';

import { ScopePathOnCreateListener } from 'src/engine/core-modules/country-scope/listeners/scope-path-on-create.listener';
import { GlobalWorkspaceOrmManager } from 'src/engine/twenty-orm/global-workspace-datasource/global-workspace-orm.manager';
import { type WorkspaceEventBatch } from 'src/engine/workspace-event-emitter/types/workspace-event-batch.type';

describe('ScopePathOnCreateListener', () => {
  let listener: ScopePathOnCreateListener;

  const companyRepository = { update: jest.fn(), findOne: jest.fn() };
  const personRepository = { update: jest.fn(), findOne: jest.fn() };
  const memberRepository = { findOne: jest.fn() };
  const getRepository = jest.fn();

  beforeEach(async () => {
    jest.clearAllMocks();

    getRepository.mockImplementation(
      (_workspaceId: string, entityName: string) =>
        Promise.resolve(
          entityName === 'workspaceMember'
            ? memberRepository
            : entityName === 'company'
              ? companyRepository
              : personRepository,
        ),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScopePathOnCreateListener,
        {
          provide: GlobalWorkspaceOrmManager,
          useValue: {
            getRepository,
            executeInWorkspaceContext: jest
              .fn()
              .mockImplementation((callback: () => unknown) => callback()),
          },
        },
      ],
    }).compile();

    listener = module.get<ScopePathOnCreateListener>(ScopePathOnCreateListener);
  });

  const batch = (
    objectName: string,
    events: {
      recordId: string;
      workspaceMemberId?: string;
      after: Record<string, unknown>;
    }[],
  ): WorkspaceEventBatch<ObjectRecordCreateEvent> =>
    ({
      name: `${objectName}.created`,
      workspaceId: 'workspace-id',
      objectMetadata: { nameSingular: objectName },
      events: events.map(({ recordId, workspaceMemberId, after }) => ({
        recordId,
        workspaceMemberId,
        properties: { after },
      })),
    }) as unknown as WorkspaceEventBatch<ObjectRecordCreateEvent>;

  const membreAvecJetons = (allowedScopes: string | null) =>
    memberRepository.findOne.mockResolvedValue({
      id: 'wm-1',
      allowedScopes,
      allowedCountries: null,
    });

  it('pose scopePath encadre sur une societe, depuis le perimetre du createur', async () => {
    membreAvecJetons('g:131,g:229');

    await listener.handleCompanyCreate(
      batch('company', [
        { recordId: 'co-1', workspaceMemberId: 'wm-1', after: { id: 'co-1' } },
      ]),
    );

    expect(companyRepository.update).toHaveBeenCalledWith('co-1', {
      scopePath: '|g:131|g:229|',
    });
  });

  it('trie et deduplique les jetons', async () => {
    // Contrat avec `build_scope_path` cote Python : sans ordre stable, le recalcul par lot
    // reecrirait tous les enregistrements et son compteur de mutations ne dirait plus rien.
    membreAvecJetons('g:229, g:131 ,g:229');

    await listener.handleCompanyCreate(
      batch('company', [
        { recordId: 'co-1', workspaceMemberId: 'wm-1', after: { id: 'co-1' } },
      ]),
    );

    expect(companyRepository.update).toHaveBeenCalledWith('co-1', {
      scopePath: '|g:131|g:229|',
    });
  });

  it('🔴 le pays est un REPLI, jamais un cumul', async () => {
    // Un manager de zone porte des groupes ET des pays. Poser les deux rendrait
    // l'enregistrement visible a quiconque partage juste le pays — la fuite fermee par
    // l'amendement du 2026-08-17.
    membreAvecJetons('g:023,g:219,c:BF,c:BJ,c:SN');

    await listener.handleCompanyCreate(
      batch('company', [
        { recordId: 'co-1', workspaceMemberId: 'wm-1', after: { id: 'co-1' } },
      ]),
    );

    expect(companyRepository.update).toHaveBeenCalledWith('co-1', {
      scopePath: '|g:023|g:219|',
    });
  });

  it("retombe sur les jetons pays quand le createur n'a aucun groupe", async () => {
    membreAvecJetons('c:ES,c:PT');

    await listener.handleCompanyCreate(
      batch('company', [
        { recordId: 'co-1', workspaceMemberId: 'wm-1', after: { id: 'co-1' } },
      ]),
    );

    expect(companyRepository.update).toHaveBeenCalledWith('co-1', {
      scopePath: '|c:ES|c:PT|',
    });
  });

  it("🔴 n'ecrit RIEN sans workspaceMemberId — c'est l'ingestion qui ecrit", async () => {
    // Cle API ou contexte systeme : le pipeline a sa propre chaine de calcul de portee.
    // Inventer une portee ici la lui volerait.
    await listener.handleCompanyCreate(
      batch('company', [{ recordId: 'co-1', after: { id: 'co-1' } }]),
    );

    expect(companyRepository.update).not.toHaveBeenCalled();
    expect(memberRepository.findOne).not.toHaveBeenCalled();
  });

  it("🔴 n'ecrase JAMAIS une portee deja posee", async () => {
    membreAvecJetons('g:131');

    await listener.handleCompanyCreate(
      batch('company', [
        {
          recordId: 'co-1',
          workspaceMemberId: 'wm-1',
          after: { id: 'co-1', scopePath: '|g:999|' },
        },
      ]),
    );

    expect(companyRepository.update).not.toHaveBeenCalled();
  });

  it("n'ecrit rien pour un createur non cloisonne (sentinelle *)", async () => {
    // Un administrateur ne doit pas imprimer `|*|` sur un enregistrement : `*` est une
    // sentinelle cote membre, pas un jeton cote donnee.
    membreAvecJetons('*');

    await listener.handleCompanyCreate(
      batch('company', [
        { recordId: 'co-1', workspaceMemberId: 'wm-1', after: { id: 'co-1' } },
      ]),
    );

    expect(companyRepository.update).not.toHaveBeenCalled();
  });

  it("n'ecrit rien pour un createur sans aucun perimetre", async () => {
    membreAvecJetons(null);

    await listener.handleCompanyCreate(
      batch('company', [
        { recordId: 'co-1', workspaceMemberId: 'wm-1', after: { id: 'co-1' } },
      ]),
    );

    expect(companyRepository.update).not.toHaveBeenCalled();
  });

  it('🔴 un contact herite de SA SOCIETE, pas de son createur', async () => {
    // L'invariant central des dependants. Le createur porte g:131 ET g:229 ; la societe ne
    // porte que g:131. Poser les jetons du createur rendrait le contact visible a un
    // collegue qui ne voit pas la societe — un enfant plus visible que son parent.
    membreAvecJetons('g:131,g:229');
    companyRepository.findOne.mockResolvedValue({
      id: 'co-1',
      scopePath: '|g:131|',
    });

    await listener.handlePersonCreate(
      batch('person', [
        {
          recordId: 'pe-1',
          workspaceMemberId: 'wm-1',
          after: { id: 'pe-1', companyId: 'co-1' },
        },
      ]),
    );

    expect(personRepository.update).toHaveBeenCalledWith('pe-1', {
      scopePath: '|g:131|',
    });
  });

  it("retombe sur le createur quand la societe parente n'a pas encore de portee", async () => {
    // Le cas d'une societe et de son contact crees dans le meme geste : le parent vient
    // d'etre servi par ce meme listener, aligner l'enfant est correct.
    membreAvecJetons('g:131,g:229');
    companyRepository.findOne.mockResolvedValue({ id: 'co-1', scopePath: '' });

    await listener.handlePersonCreate(
      batch('person', [
        {
          recordId: 'pe-1',
          workspaceMemberId: 'wm-1',
          after: { id: 'pe-1', companyId: 'co-1' },
        },
      ]),
    );

    expect(personRepository.update).toHaveBeenCalledWith('pe-1', {
      scopePath: '|g:131|g:229|',
    });
  });

  it('retombe sur le createur pour un enregistrement orphelin', async () => {
    membreAvecJetons('g:131');

    await listener.handlePersonCreate(
      batch('person', [
        { recordId: 'pe-1', workspaceMemberId: 'wm-1', after: { id: 'pe-1' } },
      ]),
    );

    expect(companyRepository.findOne).not.toHaveBeenCalled();
    expect(personRepository.update).toHaveBeenCalledWith('pe-1', {
      scopePath: '|g:131|',
    });
  });

  it('lit la societe par clientId sur une visite', async () => {
    // ⚠️ La relation ne s'appelle pas pareil partout : `client` sur visit et clientProduct,
    // `company` sur person et opportunity. S'etre trompe coute une passe entiere.
    membreAvecJetons('g:131,g:229');
    companyRepository.findOne.mockResolvedValue({
      id: 'co-1',
      scopePath: '|g:229|',
    });

    await listener.handleVisitCreate(
      batch('visit', [
        {
          recordId: 'vi-1',
          workspaceMemberId: 'wm-1',
          after: { id: 'vi-1', clientId: 'co-1' },
        },
      ]),
    );

    expect(companyRepository.findOne).toHaveBeenCalledWith({
      where: { id: 'co-1' },
    });
    expect(personRepository.update).toHaveBeenCalledWith('vi-1', {
      scopePath: '|g:229|',
    });
  });

  it('🔴 ne laisse JAMAIS sortir une exception', async () => {
    // [[L97]] : un listener de creation qui leve fait echouer la creation elle-meme. Le
    // commercial verrait une erreur au lieu d'un enregistrement — pire que le defaut repare.
    getRepository.mockRejectedValue(
      new Error('objet custom absent du workspace'),
    );

    await expect(
      listener.handleCompanyCreate(
        batch('company', [
          {
            recordId: 'co-1',
            workspaceMemberId: 'wm-1',
            after: { id: 'co-1' },
          },
        ]),
      ),
    ).resolves.toBeUndefined();
  });

  it('un enregistrement en echec ne prive pas les autres du lot', async () => {
    membreAvecJetons('g:131');
    companyRepository.update
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);

    await listener.handleCompanyCreate(
      batch('company', [
        { recordId: 'co-1', workspaceMemberId: 'wm-1', after: { id: 'co-1' } },
        { recordId: 'co-2', workspaceMemberId: 'wm-1', after: { id: 'co-2' } },
      ]),
    );

    expect(companyRepository.update).toHaveBeenCalledTimes(2);
    expect(companyRepository.update).toHaveBeenLastCalledWith('co-2', {
      scopePath: '|g:131|',
    });
  });

  it("ne relit le membre qu'une fois par lot", async () => {
    membreAvecJetons('g:131');

    await listener.handleCompanyCreate(
      batch('company', [
        { recordId: 'co-1', workspaceMemberId: 'wm-1', after: { id: 'co-1' } },
        { recordId: 'co-2', workspaceMemberId: 'wm-1', after: { id: 'co-2' } },
        { recordId: 'co-3', workspaceMemberId: 'wm-1', after: { id: 'co-3' } },
      ]),
    );

    expect(memberRepository.findOne).toHaveBeenCalledTimes(1);
    expect(companyRepository.update).toHaveBeenCalledTimes(3);
  });
});
