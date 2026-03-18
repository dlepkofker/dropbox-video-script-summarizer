CREATE TABLE IF NOT EXISTS public.prompts (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  title character varying NOT NULL UNIQUE,
  text text NOT NULL,
  CONSTRAINT prompts_pkey PRIMARY KEY (id)
);
