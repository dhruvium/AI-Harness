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
    reasoning: Optional[str] = None


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


class UiSettings(BaseModel):
    lastProviderId: Optional[str] = None
    effort: Literal["none", "low", "medium", "high"] = "none"
    systemPrompt: str = ""


class PowerSettings(BaseModel):
    preventSleep: bool = False


class AppSettings(BaseModel):
    memory: MemorySettings = Field(default_factory=MemorySettings)
    browser: BrowserSettings = Field(default_factory=BrowserSettings)
    power: PowerSettings = Field(default_factory=PowerSettings)
    ui: UiSettings = Field(default_factory=UiSettings)


class MemoryItem(BaseModel):
    id: str
    text: str


class ArchiveIn(BaseModel):
    archived: bool


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
    projectId: Optional[str] = None
    effort: str = "none"
    system: str = ""
    useMemory: Optional[bool] = None
    archived: bool = False
    messages: List[ChatMessage] = []
    updatedAt: float = 0


class Project(BaseModel):
    id: str
    name: str
    path: Optional[str] = None
    createdAt: float = 0


class ProjectIn(BaseModel):
    name: str
    path: Optional[str] = None
