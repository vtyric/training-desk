DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM training_users old_user
        JOIN training_users new_user ON new_user.team_id = old_user.team_id
        WHERE old_user.username = 'agent' AND new_user.username = 'support'
    ) THEN
        RAISE EXCEPTION 'Cannot rename Service Desk user agent: support already exists in the same team';
    END IF;
END $$;

UPDATE training_users SET username = 'support' WHERE username = 'agent';
UPDATE api_tokens SET username = 'support' WHERE username = 'agent';
UPDATE issues
SET reporter = 'support'
WHERE reporter = 'agent';
UPDATE issues
SET assignee = 'support'
WHERE assignee = 'agent';
UPDATE comments SET author = 'support' WHERE author = 'agent';
UPDATE issue_history SET author = 'support' WHERE author = 'agent';
