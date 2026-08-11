import { Test, type TestingModule } from '@nestjs/testing';

import { type EntityManager } from 'typeorm';
import { MessageChannelVisibility } from 'twenty-shared/types';

import { CreateMessageChannelService } from 'src/engine/core-modules/auth/services/create-message-channel.service';
import { GlobalWorkspaceOrmManager } from 'src/engine/twenty-orm/global-workspace-datasource/global-workspace-orm.manager';

// Ce fallback n'est pas un détail : le bouton « Connect with Microsoft/Google » de
// Settings → Accounts et le chemin IMAP/SMTP n'envoient AUCUNE visibilité, donc il décide
// du réglage effectif de la quasi-totalité des comptes connectés.
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
          provide: GlobalWorkspaceOrmManager,
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
