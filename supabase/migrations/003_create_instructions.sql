CREATE TABLE IF NOT EXISTS public.instructions (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  text text NOT NULL,
  title text NOT NULL UNIQUE,
  CONSTRAINT instructions_pkey PRIMARY KEY (id)
);
