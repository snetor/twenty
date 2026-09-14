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
  // Une jonction d'activité écrit sur DEUX objets : elle-même et la note/tâche qu'elle
  // rattache. Les confondre dans le mock ferait passer un test qui ne prouve rien.
  const noteRepository = { update: jest.fn(), findOne: jest.fn() };
  const taskRepository = { update: jest.fn(), findOne: jest.fn() };
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
              : entityName === 'note'
                ? noteRepository
                : entityName === 'task'
                  ? taskRepository
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

  // --- Notes et tâches : la portée passe par la jonction.
  //
  // 🔴 Pourquoi `noteTarget CREATED` et pas `note CREATED` : `noteTarget.noteId` est une
  // clé étrangère vers la note, donc la jonction NE PEUT PAS exister avant elle. Le front
  // crée bien dans cet ordre (`useCreateActivityInDB.ts`). À `note CREATED`, la société
  // rattachée est toujours inconnue — accrocher cet événement aurait posé une portée
  // systématiquement fausse (celle du créateur, plus large que celle du client).
  //
  // Dans ces tests, `personRepository` est le dépôt générique rendu par le mock : c'est
  // celui de la JONCTION. `noteRepository` / `taskRepository` sont ceux de l'activité.

  it('🔴 pose la portee de la societe sur la note ET sur sa jonction', async () => {
    membreAvecJetons('g:131,g:229');
    companyRepository.findOne.mockResolvedValue({
      id: 'co-1',
      scopePath: '|g:131|',
    });
    noteRepository.findOne.mockResolvedValue({ id: 'no-1', scopePath: null });

    await listener.handleNoteTargetCreate(
      batch('noteTarget', [
        {
          recordId: 'nt-1',
          workspaceMemberId: 'wm-1',
          after: { id: 'nt-1', noteId: 'no-1', targetCompanyId: 'co-1' },
        },
      ]),
    );

    // La jonction, pour qu'elle sorte du default-deny et que l'onglet Notes de la fiche
    // client la retourne.
    expect(personRepository.update).toHaveBeenCalledWith('nt-1', {
      scopePath: '|g:131|',
    });
    // La note elle-même — c'est CE write qui la rend visible : le filtre ne joint pas, il
    // lit une colonne sur la ligne qu'il retourne.
    expect(noteRepository.update).toHaveBeenCalledWith('no-1', {
      scopePath: '|g:131|',
    });
  });

  it('🔴 la note herite de SA SOCIETE, pas du perimetre de son auteur', async () => {
    // L'auteur porte deux groupes, le client un seul. Poser les deux montrerait la note à
    // un collègue qui ne voit pas le client — une note est souvent plus bavarde que la
    // fiche société elle-même.
    membreAvecJetons('g:131,g:229');
    companyRepository.findOne.mockResolvedValue({
      id: 'co-1',
      scopePath: '|g:131|',
    });
    noteRepository.findOne.mockResolvedValue({ id: 'no-1', scopePath: null });

    await listener.handleNoteTargetCreate(
      batch('noteTarget', [
        {
          recordId: 'nt-1',
          workspaceMemberId: 'wm-1',
          after: { id: 'nt-1', noteId: 'no-1', targetCompanyId: 'co-1' },
        },
      ]),
    );

    expect(noteRepository.update).toHaveBeenCalledWith('no-1', {
      scopePath: '|g:131|',
    });
  });

  it('fait la meme chose pour une tache via taskTarget', async () => {
    membreAvecJetons('g:229');
    companyRepository.findOne.mockResolvedValue({
      id: 'co-1',
      scopePath: '|g:229|',
    });
    taskRepository.findOne.mockResolvedValue({ id: 'ta-1', scopePath: null });

    await listener.handleTaskTargetCreate(
      batch('taskTarget', [
        {
          recordId: 'tt-1',
          workspaceMemberId: 'wm-1',
          after: { id: 'tt-1', taskId: 'ta-1', targetCompanyId: 'co-1' },
        },
      ]),
    );

    expect(personRepository.update).toHaveBeenCalledWith('tt-1', {
      scopePath: '|g:229|',
    });
    expect(taskRepository.update).toHaveBeenCalledWith('ta-1', {
      scopePath: '|g:229|',
    });
  });

  it("🔴 n'ecrase pas la portee d'une tache deja servie par une premiere cible", async () => {
    // Mesuré sur le workspace : certaines tâches portent deux cibles. La première servie
    // gagne ; l'union des sociétés est l'affaire du recalcul par lot, qui est propriétaire
    // de la valeur. Écraser ici ferait perdre la portée posée par l'autre jonction.
    membreAvecJetons('g:131');
    companyRepository.findOne.mockResolvedValue({
      id: 'co-2',
      scopePath: '|g:131|',
    });
    taskRepository.findOne.mockResolvedValue({
      id: 'ta-1',
      scopePath: '|g:229|',
    });

    await listener.handleTaskTargetCreate(
      batch('taskTarget', [
        {
          recordId: 'tt-2',
          workspaceMemberId: 'wm-1',
          after: { id: 'tt-2', taskId: 'ta-1', targetCompanyId: 'co-2' },
        },
      ]),
    );

    // La jonction, elle, reçoit bien sa portée.
    expect(personRepository.update).toHaveBeenCalledWith('tt-2', {
      scopePath: '|g:131|',
    });
    expect(taskRepository.update).not.toHaveBeenCalled();
  });

  it("retombe sur l'auteur quand la jonction ne cible aucune societe", async () => {
    // Une note attachée à un contact ou à une opportunité, pas à une société : le parent
    // n'est pas résoluble par ce chemin, on aligne sur l'auteur comme pour tout
    // enregistrement orphelin. Le recalcul par lot corrigera.
    membreAvecJetons('g:131');
    noteRepository.findOne.mockResolvedValue({ id: 'no-2', scopePath: null });

    await listener.handleNoteTargetCreate(
      batch('noteTarget', [
        {
          recordId: 'nt-2',
          workspaceMemberId: 'wm-1',
          after: { id: 'nt-2', noteId: 'no-2' },
        },
      ]),
    );

    expect(companyRepository.findOne).not.toHaveBeenCalled();
    expect(noteRepository.update).toHaveBeenCalledWith('no-2', {
      scopePath: '|g:131|',
    });
  });

  it("🔴 n'ecrit RIEN sur une jonction creee par la cle API", async () => {
    // 191 des 196 notes du workspace sont dans ce cas. Leur portée est l'affaire du
    // backfill, pas de ce listener : inventer ici le périmètre d'un membre inexistant
    // serait exactement l'erreur que le filtre par auteur commettait.
    await listener.handleNoteTargetCreate(
      batch('noteTarget', [
        {
          recordId: 'nt-3',
          after: { id: 'nt-3', noteId: 'no-3', targetCompanyId: 'co-1' },
        },
      ]),
    );

    expect(personRepository.update).not.toHaveBeenCalled();
    expect(noteRepository.update).not.toHaveBeenCalled();
  });

  it('ne touche pas la note quand la jonction ne porte pas son id', async () => {
    membreAvecJetons('g:131');

    await listener.handleNoteTargetCreate(
      batch('noteTarget', [
        {
          recordId: 'nt-4',
          workspaceMemberId: 'wm-1',
          after: { id: 'nt-4' },
        },
      ]),
    );

    expect(personRepository.update).toHaveBeenCalledWith('nt-4', {
      scopePath: '|g:131|',
    });
    expect(noteRepository.findOne).not.toHaveBeenCalled();
    expect(noteRepository.update).not.toHaveBeenCalled();
  });

  it("ne laisse pas sortir une exception venue de l'ecriture sur la note", async () => {
    // [[L97]] : lever ici ferait échouer la création de la jonction, donc l'ajout de la
    // note depuis la fiche client. Un enregistrement sans portée reste moins grave qu'une
    // erreur à l'écran.
    membreAvecJetons('g:131');
    noteRepository.findOne.mockRejectedValue(new Error('champ custom absent'));

    await expect(
      listener.handleNoteTargetCreate(
        batch('noteTarget', [
          {
            recordId: 'nt-5',
            workspaceMemberId: 'wm-1',
            after: { id: 'nt-5', noteId: 'no-5' },
          },
        ]),
      ),
    ).resolves.toBeUndefined();
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
