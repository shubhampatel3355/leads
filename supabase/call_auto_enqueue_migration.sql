-- Automatically enqueue an AI call when a lead transitions from cold -> warm.
-- This covers score/classification changes made outside the backend worker,
-- such as direct edits in Supabase Table Editor.

CREATE OR REPLACE FUNCTION enqueue_ai_call_on_warm_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF COALESCE(OLD.classification, 'cold') = 'cold'
       AND NEW.classification = 'warm'
       AND NEW.phone IS NOT NULL
       AND btrim(NEW.phone) <> '' THEN
        INSERT INTO jobs (
            type,
            payload,
            status,
            max_retries,
            run_at
        )
        VALUES (
            'ai-call-initiate',
            jsonb_build_object(
                'lead_id', NEW.id,
                'phone', NEW.phone
            ),
            'pending',
            3,
            NOW()
        );
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS leads_enqueue_ai_call_on_warm ON leads;

CREATE TRIGGER leads_enqueue_ai_call_on_warm
AFTER UPDATE OF classification ON leads
FOR EACH ROW
WHEN (OLD.classification IS DISTINCT FROM NEW.classification)
EXECUTE FUNCTION enqueue_ai_call_on_warm_transition();
