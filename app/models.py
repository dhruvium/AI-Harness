from pydantic import BaseModel, Field
from typing import Optional, List, Literal, Union


class Provider(BaseModel):
    id: str
    name: str
    baseUrl: str
    apiKey: str = ""
    model: str
    format: Literal["openai", "anthropic"] = "openai"
    contextWindow: int = 128000
    maxTokens: Optional[int] = None


class ProviderIn(BaseModel):
    name: str
    baseUrl: str
    apiKey: str = ""
    model: str
    format: Literal["openai", "anthropic"] = "openai"
    contextWindow: int = Field(default=128000, ge=1000)
    maxTokens: Optional[int] = None


class TextPart(BaseModel):
    type: Literal["text"]
    text: str


class RefPart(BaseModel):
    type: Literal["ref"]
    uploadId: str


Part = Union[TextPart, RefPart]


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    parts: List[Part]


class ChatRequest(BaseModel):
    providerId: str
    system: str = ""
    effort: Literal["none", "low", "medium", "high"] = "none"
    useMemory: bool = False
    messages: List[ChatMessage]


class MemorySettings(BaseModel):
    enabled: bool = False


class BrowserSettings(BaseModel):
    enabled: bool = False
    ignoreCertErrors: bool = False


class AppSettings(BaseModel):
    memory: MemorySettings = Field(default_factory=MemorySettings)
    browser: BrowserSettings = Field(default_factory=BrowserSettings)


class MemoryItem(BaseModel):
    id: str
    text: str


class UploadOut(BaseModel):
    id: str
    name: str
    size: int
    mime: str
    kind: Literal["image", "pdf", "text"]


class Conversation(BaseModel):
    id: str
    title: str
    providerId: Optional[str] = None
    effort: str = "none"
    system: str = ""
    useMemory: Optional[bool] = None
    messages: List[ChatMessage] = []
    updatedAt: float = 0
