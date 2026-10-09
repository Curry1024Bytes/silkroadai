-- 官方创建参数 execution_expires_after 落库回显(可空,非破坏)。
ALTER TABLE "seedance_video_tasks" ADD COLUMN "execution_expires_after" INTEGER;
