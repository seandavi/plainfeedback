from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Single postgresql:// URI; never log it (contains the password).
    database_url: str = "postgresql://plainfeedback:plainfeedback@localhost:5432/plainfeedback"


@lru_cache
def get_settings() -> Settings:
    return Settings()
