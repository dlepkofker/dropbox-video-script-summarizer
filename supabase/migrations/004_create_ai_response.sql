-- ai_response depends on transcripts (video_id), prompts (prompt_id), and instructions (instruction_id)
-- so this must run after migrations 001, 002, and 003.
CREATE TABLE IF NOT EXISTS public.ai_response (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  video_id character varying NOT NULL UNIQUE,
  prompt_id bigint NOT NULL,
  response text,
  prompt_fields jsonb,
  instruction_id bigint,
  CONSTRAINT ai_response_pkey PRIMARY KEY (id),
  CONSTRAINT ai_response_prompt_id_fkey FOREIGN KEY (prompt_id) REFERENCES public.prompts(id),
  CONSTRAINT ai_response_video_id_fkey FOREIGN KEY (video_id) REFERENCES public.transcripts(video_id),
  CONSTRAINT ai_response_instruction_id_fkey FOREIGN KEY (instruction_id) REFERENCES public.instructions(id)
);
