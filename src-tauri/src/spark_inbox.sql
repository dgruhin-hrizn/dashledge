PRAGMA trusted_schema=OFF;
PRAGMA query_only=ON;
SELECT json_object(
    'unread', (SELECT count(*) FROM messages WHERE inInbox = 1 AND unseen = 1),
    'items', (SELECT json_group_array(json_object(
        'id', pk, 'subject', coalesce(nullif(subject, ''), '(No subject)'),
        'sender', coalesce(nullif(messageFrom, ''), messageFromMailbox, 'Unknown sender'),
        'received', receivedDate * 1000, 'unread', unseen
    )) FROM (
        SELECT pk, subject, messageFrom, messageFromMailbox, receivedDate, unseen
        FROM messages WHERE inInbox = 1
        ORDER BY receivedDate DESC, pk DESC LIMIT 8
    ))
);
