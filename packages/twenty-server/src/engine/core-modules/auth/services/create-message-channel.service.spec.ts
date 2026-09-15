import { Test, type TestingModule } from '@nestjs/testing';

import { type EntityManager } from 'typeorm';
import { MessageChannelVisibility } from 'twenty-shared/types';

import { CreateMessageChannelService } from 'src/engine/core-modules/auth/services/create-message-channel.service';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';

// Ce fallback n'est pas un détail : le bouton « Connect with Microsoft/Google » de
// Settings → Accounts et le chemin IMAP/SMTP n'envoient AUCUNE visibilité, donc il décide
// du réglage effectif de la quasi-totalité des comptes connectés.
//
// ⚠️ CETTE SPEC NE DÉFEND PLUS UN PATCH SNETOR — NE PAS LA SUPPRIMER POUR AUTANT.
// Le fork imposait `METADATA` par défaut depuis la PR #11. En v2.39.0 l'amont a adopté
// exactement la même valeur, donc le patch a été retiré à la montée : le comportement
// vient maintenant du code amont.
// C'est précisément ce qui rend cette spec utile. Une dépendance qu'on ne patche plus est
// une dépendance que rien ne surveille : si une release future revenait à
// `SHARE_EVERYTHING`, le corps des mails de tous les commerciaux serait repartagé au
// workspace entier, sans conflit de merge et sans erreur. Cette spec est le seul endroit
// qui s'en apercevrait.
describe('CreateMessageChannelService', () => {
  let service: CreateMessageChannelService;

  const save = jest.fn();
  const mockTransactionManager = {
    getRepository: jest.fn().mockReturnValue({ save }),
  } as unknown as EntityManager;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreateMessageChannelService,
        {
          provide: WorkspaceOrmManager,
          useValue: {
            executeInWorkspaceContext: jest.fn((callback) => callback()),
          },
        },
      ],
    }).compile();

    service = module.get<CreateMessageChannelService>(
      CreateMessageChannelService,
    );
  });

  const createMessageChannel = (messageVisibility?: MessageChannelVisibility) =>
    service.createMessageChannel({
      workspaceId: 'workspace-id',
      connectedAccountId: 'connected-account-id',
      handle: 'sales@snetor.com',
      messageVisibility,
      transactionManager: mockTransactionManager,
    });

  it('pose METADATA quand aucune visibilité n’est demandée (défaut fermé)', async () => {
    await createMessageChannel();

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        visibility: MessageChannelVisibility.METADATA,
      }),
    );
  });

  it('respecte une visibilité explicite, y compris SHARE_EVERYTHING', async () => {
    await createMessageChannel(MessageChannelVisibility.SHARE_EVERYTHING);

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        visibility: MessageChannelVisibility.SHARE_EVERYTHING,
      }),
    );
  });

  it('respecte SUBJECT sans le rabattre sur le défaut', async () => {
    await createMessageChannel(MessageChannelVisibility.SUBJECT);

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        visibility: MessageChannelVisibility.SUBJECT,
      }),
    );
  });
});
