CREATE TABLE IF NOT EXISTS public.transcripts (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  transcript text,
  video_id character varying NOT NULL UNIQUE,
  CONSTRAINT transcripts_pkey PRIMARY KEY (id)
);
