import gql from 'graphql-tag';
import { createOneOperationFactory } from 'test/integration/graphql/utils/create-one-operation-factory.util';
import { destroyOneOperationFactory } from 'test/integration/graphql/utils/destroy-one-operation-factory.util';
import { makeGraphqlApiRequest } from 'test/integration/graphql/utils/make-graphql-api-request.util';
import { updateOneOperationFactory } from 'test/integration/graphql/utils/update-one-operation-factory.util';
import { createOneFieldMetadata } from 'test/integration/metadata/suites/field-metadata/utils/create-one-field-metadata.util';
import { deleteOneFieldMetadata } from 'test/integration/metadata/suites/field-metadata/utils/delete-one-field-metadata.util';
import { updateOneFieldMetadata } from 'test/integration/metadata/suites/field-metadata/utils/update-one-field-metadata.util';
import { findManyObjectMetadata } from 'test/integration/metadata/suites/object-metadata/utils/find-many-object-metadata.util';
import { FieldMetadataType } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';

import { WORKSPACE_MEMBER_DATA_SEED_IDS } from 'src/engine/workspace-manager/dev-seeder/data/constants/workspace-member-data-seeds.constant';

// Snetor integration case (the upstream timeline spec stays untouched).
//
// Upstream v2.45 resolves a `targetFilter` for every workspace: a timeline is selected by TARGET
// RECORD, with no related person needed. The fork must keep that for an unscoped member (the
// upstream spec covers it) and must give a SCOPED member nothing from a company that has no
// in-scope person. The acting member of `makeGraphqlApiRequest` is Jane; this spec makes her
// scoped by creating the custom field `workspaceMember.allowedCountries` (a Snetor field that
// lives in workspace metadata, not in the code) and always puts her back to all countries and
// removes the field afterwards, because a leftover scope would filter every later spec.

const COMPANY_ID = '20202020-7e58-4000-8000-000000000001';
const THREAD_ID = '20202020-7e58-4000-8000-000000000002';
const MESSAGE_ID = '20202020-7e58-4000-8000-000000000003';
const MESSAGE_PARTICIPANT_ID = '20202020-7e58-4000-8000-000000000004';
const THREAD_TARGET_ID = '20202020-7e58-4000-8000-000000000005';
const EVENT_ID = '20202020-7e58-4000-8000-000000000006';
const EVENT_TARGET_ID = '20202020-7e58-4000-8000-000000000007';

const ALL_COUNTRIES = '*';
const OUT_OF_SCOPE_COUNTRY = 'ZZ';

const GET_TIMELINE_THREADS = gql`
  query GetTimelineThreadsFromObjectRecord(
    $objectNameSingular: String!
    $recordId: UUID!
    $page: Int!
    $pageSize: Int!
  ) {
    getTimelineThreadsFromObjectRecord(
      objectNameSingular: $objectNameSingular
      recordId: $recordId
      page: $page
      pageSize: $pageSize
    ) {
      totalNumberOfThreads
      timelineThreads {
        id
      }
    }
  }
`;

const GET_TIMELINE_CALENDAR_EVENTS = gql`
  query GetTimelineCalendarEventsFromObjectRecord(
    $objectNameSingular: String!
    $recordId: UUID!
    $page: Int!
    $pageSize: Int!
  ) {
    getTimelineCalendarEventsFromObjectRecord(
      objectNameSingular: $objectNameSingular
      recordId: $recordId
      page: $page
      pageSize: $pageSize
    ) {
      totalNumberOfCalendarEvents
      timelineCalendarEvents {
        id
      }
    }
  }
`;

const requestTimeline = (query: typeof GET_TIMELINE_THREADS) =>
  makeGraphqlApiRequest({
    query,
    variables: {
      objectNameSingular: 'company',
      recordId: COMPANY_ID,
      page: 1,
      pageSize: 50,
    },
  });

const createRecord = async (
  objectMetadataSingularName: string,
  data: object,
) => {
  const response = await makeGraphqlApiRequest(
    createOneOperationFactory({
      objectMetadataSingularName,
      gqlFields: 'id',
      data,
    }),
  );

  expect(response.body.errors).toBeUndefined();
};

const setActingMemberCountries = (allowedCountries: string) =>
  makeGraphqlApiRequest(
    updateOneOperationFactory({
      objectMetadataSingularName: 'workspaceMember',
      gqlFields: 'id',
      recordId: WORKSPACE_MEMBER_DATA_SEED_IDS.JANE,
      data: { allowedCountries },
    }),
  );

// Child before parent, to satisfy foreign keys.
const FIXTURES: { objectMetadataSingularName: string; id: string }[] = [
  { objectMetadataSingularName: 'calendarEventTarget', id: EVENT_TARGET_ID },
  { objectMetadataSingularName: 'messageThreadTarget', id: THREAD_TARGET_ID },
  { objectMetadataSingularName: 'calendarEvent', id: EVENT_ID },
  {
    objectMetadataSingularName: 'messageParticipant',
    id: MESSAGE_PARTICIPANT_ID,
  },
  { objectMetadataSingularName: 'message', id: MESSAGE_ID },
  { objectMetadataSingularName: 'messageThread', id: THREAD_ID },
  { objectMetadataSingularName: 'company', id: COMPANY_ID },
];

describe('timeline from object record, scoped member (integration)', () => {
  let allowedCountriesFieldId: string | undefined;

  beforeAll(async () => {
    // A company with NO related person, whose thread and event are reachable only through a target.
    await createRecord('company', {
      id: COMPANY_ID,
      name: 'Scoped Timeline Company',
    });
    await createRecord('messageThread', { id: THREAD_ID });
    await createRecord('message', {
      id: MESSAGE_ID,
      messageThreadId: THREAD_ID,
      subject: 'Scoped timeline thread',
      text: 'Scoped timeline message body',
      receivedAt: new Date().toISOString(),
    });
    await createRecord('messageParticipant', {
      id: MESSAGE_PARTICIPANT_ID,
      messageId: MESSAGE_ID,
      role: 'FROM',
      handle: 'scoped.timeline@example.com',
      displayName: 'Scoped Timeline',
    });
    await createRecord('messageThreadTarget', {
      id: THREAD_TARGET_ID,
      messageThreadId: THREAD_ID,
      targetCompanyId: COMPANY_ID,
    });
    await createRecord('calendarEvent', {
      id: EVENT_ID,
      title: 'Scoped timeline event',
      isFullDay: false,
      startsAt: new Date().toISOString(),
      endsAt: new Date().toISOString(),
    });
    await createRecord('calendarEventTarget', {
      id: EVENT_TARGET_ID,
      calendarEventId: EVENT_ID,
      targetCompanyId: COMPANY_ID,
    });

    const { objects } = await findManyObjectMetadata({
      input: { filter: {}, paging: { first: 100 } },
      gqlFields: 'id nameSingular',
      expectToFail: false,
    });
    const workspaceMemberObject = objects.find(
      (object) => object.nameSingular === 'workspaceMember',
    );

    if (!isDefined(workspaceMemberObject)) {
      throw new Error('workspaceMember object metadata not found');
    }

    const { data } = await createOneFieldMetadata({
      input: {
        objectMetadataId: workspaceMemberObject.id,
        type: FieldMetadataType.TEXT,
        name: 'allowedCountries',
        label: 'Allowed countries',
      },
      gqlFields: 'id',
      expectToFail: false,
    });

    allowedCountriesFieldId = data.createOneField.id;

    // Start from an explicit, unscoped member.
    const response = await setActingMemberCountries(ALL_COUNTRIES);

    expect(response.body.errors).toBeUndefined();
  });

  afterAll(async () => {
    // Order matters: un-scope the acting member FIRST, otherwise the scope filters the cleanup.
    try {
      await setActingMemberCountries(ALL_COUNTRIES);
    } finally {
      for (const { objectMetadataSingularName, id } of FIXTURES) {
        await makeGraphqlApiRequest(
          destroyOneOperationFactory({
            objectMetadataSingularName,
            gqlFields: 'id',
            recordId: id,
          }),
        );
      }

      if (isDefined(allowedCountriesFieldId)) {
        await updateOneFieldMetadata({
          input: {
            idToUpdate: allowedCountriesFieldId,
            updatePayload: { isActive: false },
          },
          expectToFail: false,
        });
        await deleteOneFieldMetadata({
          input: { idToDelete: allowedCountriesFieldId },
          expectToFail: false,
        });
      }
    }
  });

  it('control: an all-countries member sees the thread and the event of a company target without a person', async () => {
    const [threads, events] = await Promise.all([
      requestTimeline(GET_TIMELINE_THREADS),
      requestTimeline(GET_TIMELINE_CALENDAR_EVENTS),
    ]);

    expect(threads.body.errors).toBeUndefined();
    expect(events.body.errors).toBeUndefined();
    expect(
      threads.body.data.getTimelineThreadsFromObjectRecord.timelineThreads.map(
        ({ id }: { id: string }) => id,
      ),
    ).toContain(THREAD_ID);
    expect(
      events.body.data.getTimelineCalendarEventsFromObjectRecord.timelineCalendarEvents.map(
        ({ id }: { id: string }) => id,
      ),
    ).toContain(EVENT_ID);
  });

  it('a scoped member gets no thread and no event from a company target without an in-scope person', async () => {
    const scopeResponse = await setActingMemberCountries(OUT_OF_SCOPE_COUNTRY);

    expect(scopeResponse.body.errors).toBeUndefined();

    const [threads, events] = await Promise.all([
      requestTimeline(GET_TIMELINE_THREADS),
      requestTimeline(GET_TIMELINE_CALENDAR_EVENTS),
    ]);

    expect(threads.body.errors).toBeUndefined();
    expect(events.body.errors).toBeUndefined();
    expect(threads.body.data.getTimelineThreadsFromObjectRecord).toMatchObject({
      totalNumberOfThreads: 0,
      timelineThreads: [],
    });
    expect(
      events.body.data.getTimelineCalendarEventsFromObjectRecord,
    ).toMatchObject({
      totalNumberOfCalendarEvents: 0,
      timelineCalendarEvents: [],
    });
  });
});
