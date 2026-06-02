import { useState } from 'react';
import { Card, CardContent } from './components/ui/card';
import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Textarea } from './components/ui/textarea';
import { ScrollArea } from './components/ui/scroll-area';
import { Separator } from './components/ui/separator';
import {
  Brain,
  MessageSquare,
  FileText,
  Code,
  Image,
  Settings,
  Download,
  Search,
  Send,
  Plus,
  Sparkles,
  ChevronDown,
  PaperclipIcon,
  Cpu,
  MemoryStick,
  HardDrive,
  Zap,
  Clock,
  MoreVertical,
  Trash2,
  Edit3,
  FolderOpen,
  Save,
  Wand2,
} from 'lucide-react';

export default function App() {
  const [activeView, setActiveView] = useState<'chat' | 'document' | 'code' | 'image' | 'models'>('chat');
  const [selectedModel, setSelectedModel] = useState('llama3.2:8b');

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {/* Sidebar */}
      <div className="w-64 border-r bg-card flex flex-col">
        {/* Logo */}
        <div className="p-4 border-b">
          <div className="flex items-center gap-2">
            <div className="size-8 rounded-lg bg-primary flex items-center justify-center">
              <Brain className="size-5 text-primary-foreground" />
            </div>
            <div>
              <div className="text-base">LocalMind</div>
              <div className="text-xs text-muted-foreground">v1.0.0</div>
            </div>
          </div>
        </div>

        {/* Navigation */}
        <ScrollArea className="flex-1">
          <div className="p-3 space-y-1">
            <Button
              variant={activeView === 'chat' ? 'secondary' : 'ghost'}
              className="w-full justify-start gap-2"
              onClick={() => setActiveView('chat')}
            >
              <MessageSquare className="size-4" />
              Chat
            </Button>
            <Button
              variant={activeView === 'document' ? 'secondary' : 'ghost'}
              className="w-full justify-start gap-2"
              onClick={() => setActiveView('document')}
            >
              <FileText className="size-4" />
              Documents
            </Button>
            <Button
              variant={activeView === 'code' ? 'secondary' : 'ghost'}
              className="w-full justify-start gap-2"
              onClick={() => setActiveView('code')}
            >
              <Code className="size-4" />
              Code Editor
            </Button>
            <Button
              variant={activeView === 'image' ? 'secondary' : 'ghost'}
              className="w-full justify-start gap-2"
              onClick={() => setActiveView('image')}
            >
              <Image className="size-4" />
              Image Gen
            </Button>
            <Button
              variant={activeView === 'models' ? 'secondary' : 'ghost'}
              className="w-full justify-start gap-2"
              onClick={() => setActiveView('models')}
            >
              <Download className="size-4" />
              Model Library
            </Button>
          </div>

          <Separator className="my-3" />

          {activeView === 'chat' && (
            <div className="p-3 space-y-2">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-muted-foreground">Recent Chats</span>
                <Button size="icon" variant="ghost" className="size-6">
                  <Plus className="size-3" />
                </Button>
              </div>
              {[
                'Hardware optimization tips',
                'Python async best practices',
                'Design system architecture',
                'SQL query performance',
              ].map((chat, i) => (
                <button
                  key={i}
                  className="w-full text-left px-3 py-2 rounded-md hover:bg-accent text-xs transition-colors flex items-center justify-between group"
                >
                  <span className="truncate flex-1">{chat}</span>
                  <MoreVertical className="size-3 opacity-0 group-hover:opacity-100" />
                </button>
              ))}
            </div>
          )}
        </ScrollArea>

        {/* System Info */}
        <div className="p-3 border-t space-y-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Cpu className="size-3" />
            <span>Intel i7-12700K</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <HardDrive className="size-3" />
            <span>NVIDIA RTX 3080 (10GB)</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <MemoryStick className="size-3" />
            <span>32GB RAM</span>
          </div>
          <Button variant="outline" size="sm" className="w-full mt-2">
            <Settings className="size-3 mr-2" />
            Settings
          </Button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col">
        {/* Top Bar */}
        <div className="h-14 border-b bg-card px-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="text-sm">
              {activeView === 'chat' && 'AI Chat'}
              {activeView === 'document' && 'Document Editor'}
              {activeView === 'code' && 'Code Editor'}
              {activeView === 'image' && 'Image Generation'}
              {activeView === 'models' && 'Model Library'}
            </h2>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="gap-2">
              <Sparkles className="size-3" />
              {selectedModel}
              <ChevronDown className="size-3" />
            </Button>
          </div>
        </div>

        {/* Chat View */}
        {activeView === 'chat' && (
          <div className="flex-1 flex flex-col">
            <ScrollArea className="flex-1 p-6">
              <div className="max-w-3xl mx-auto space-y-6">
                {/* Assistant Message */}
                <div className="flex gap-3">
                  <div className="size-8 rounded-full bg-primary flex items-center justify-center shrink-0">
                    <Brain className="size-4 text-primary-foreground" />
                  </div>
                  <div className="flex-1 space-y-2">
                    <div className="text-xs text-muted-foreground">LocalMind Assistant</div>
                    <div className="prose prose-sm">
                      <p>
                        Hello! I'm your local AI assistant running entirely on your machine. I can help you with:
                      </p>
                      <ul>
                        <li>Answering questions and having conversations</li>
                        <li>Writing and editing documents</li>
                        <li>Writing and reviewing code</li>
                        <li>Generating images from text descriptions</li>
                        <li>Using tools like file operations, web search, and calculations</li>
                      </ul>
                      <p>Your privacy is guaranteed - everything stays on your device. How can I help you today?</p>
                    </div>
                  </div>
                </div>

                {/* User Message */}
                <div className="flex gap-3 justify-end">
                  <div className="flex-1 max-w-2xl space-y-2 text-right">
                    <div className="text-xs text-muted-foreground">You</div>
                    <Card className="inline-block text-left">
                      <CardContent className="p-3">
                        <p className="text-sm">
                          Can you help me write a Python function to process image files in a directory?
                        </p>
                      </CardContent>
                    </Card>
                  </div>
                  <div className="size-8 rounded-full bg-accent flex items-center justify-center shrink-0">
                    <span className="text-xs">ME</span>
                  </div>
                </div>

                {/* Assistant Response */}
                <div className="flex gap-3">
                  <div className="size-8 rounded-full bg-primary flex items-center justify-center shrink-0">
                    <Brain className="size-4 text-primary-foreground" />
                  </div>
                  <div className="flex-1 space-y-2">
                    <div className="text-xs text-muted-foreground">LocalMind Assistant</div>
                    <div className="prose prose-sm">
                      <p>I'll help you create a Python function for processing images. Here's a solution:</p>
                    </div>
                    <Card className="bg-muted/50">
                      <CardContent className="p-4 font-mono text-xs">
                        <pre className="text-foreground/90">
{`from pathlib import Path
from PIL import Image

def process_images(directory: str, output_dir: str = "processed"):
    """Process all images in a directory."""
    input_path = Path(directory)
    output_path = Path(output_dir)
    output_path.mkdir(exist_ok=True)

    supported_formats = {'.jpg', '.jpeg', '.png', '.webp'}

    for img_file in input_path.iterdir():
        if img_file.suffix.lower() in supported_formats:
            img = Image.open(img_file)
            # Process image (example: resize)
            img = img.resize((800, 600))
            img.save(output_path / img_file.name)
            print(f"Processed: {img_file.name}")`}
                        </pre>
                      </CardContent>
                    </Card>
                  </div>
                </div>
              </div>
            </ScrollArea>

            {/* Input Area */}
            <div className="border-t bg-card p-4">
              <div className="max-w-3xl mx-auto">
                <div className="flex gap-2">
                  <div className="flex-1 relative">
                    <Textarea
                      placeholder="Ask anything... Your data stays private and local."
                      className="min-h-[60px] pr-10 resize-none"
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      className="absolute right-2 bottom-2 size-7"
                    >
                      <PaperclipIcon className="size-4" />
                    </Button>
                  </div>
                  <Button size="icon" className="size-[60px] shrink-0">
                    <Send className="size-5" />
                  </Button>
                </div>
                <div className="flex items-center justify-between mt-2 text-xs text-muted-foreground">
                  <div className="flex gap-3">
                    <span>Press Enter to send</span>
                    <span>•</span>
                    <span>Shift + Enter for new line</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Zap className="size-3" />
                    <span>Streaming enabled</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Document View */}
        {activeView === 'document' && (
          <div className="flex-1 flex">
            <div className="flex-1 flex flex-col">
              <div className="border-b p-3 flex items-center gap-2">
                <Button variant="ghost" size="sm">
                  <FolderOpen className="size-4 mr-2" />
                  Open
                </Button>
                <Button variant="ghost" size="sm">
                  <Save className="size-4 mr-2" />
                  Save
                </Button>
                <Separator orientation="vertical" className="h-6 mx-1" />
                <Button variant="ghost" size="sm">
                  <Wand2 className="size-4 mr-2" />
                  AI Actions
                </Button>
              </div>
              <ScrollArea className="flex-1">
                <div className="max-w-4xl mx-auto p-8">
                  <Input
                    placeholder="Document Title"
                    className="text-2xl border-none px-0 mb-6"
                    defaultValue="Untitled Document"
                  />
                  <div className="prose prose-sm max-w-none">
                    <p className="text-muted-foreground">
                      Start typing or use <kbd className="px-1.5 py-0.5 text-xs border rounded">/</kbd> to access AI
                      commands like /improve, /expand, /summarize, or /rewrite.
                    </p>
                    <p className="mt-4">
                      Your content here...
                    </p>
                  </div>
                </div>
              </ScrollArea>
            </div>
            <div className="w-64 border-l bg-card p-4 space-y-4">
              <div>
                <h3 className="text-sm mb-2">AI Slash Commands</h3>
                <div className="space-y-1">
                  {['/improve', '/expand', '/summarize', '/rewrite', '/translate'].map((cmd) => (
                    <div key={cmd} className="text-xs px-2 py-1 rounded bg-accent">
                      <code>{cmd}</code>
                    </div>
                  ))}
                </div>
              </div>
              <Separator />
              <div>
                <h3 className="text-sm mb-2">Export Options</h3>
                <div className="space-y-1">
                  <Button variant="outline" size="sm" className="w-full justify-start text-xs">
                    <FileText className="size-3 mr-2" />
                    Export as .docx
                  </Button>
                  <Button variant="outline" size="sm" className="w-full justify-start text-xs">
                    <FileText className="size-3 mr-2" />
                    Export as .md
                  </Button>
                  <Button variant="outline" size="sm" className="w-full justify-start text-xs">
                    <FileText className="size-3 mr-2" />
                    Export as .pdf
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Code View */}
        {activeView === 'code' && (
          <div className="flex-1 flex flex-col">
            <div className="border-b p-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm">
                  <FolderOpen className="size-4 mr-2" />
                  Open File
                </Button>
                <Button variant="ghost" size="sm">
                  <Save className="size-4 mr-2" />
                  Save
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="text-xs">Python</Badge>
                <Button variant="ghost" size="sm">
                  <Sparkles className="size-4 mr-2" />
                  AI Completions
                </Button>
              </div>
            </div>
            <div className="flex-1 bg-muted/20 font-mono text-sm">
              <div className="h-full p-4">
                <div className="space-y-0 leading-relaxed">
                  <div className="flex">
                    <span className="text-muted-foreground w-12 text-right pr-4">1</span>
                    <span className="text-purple-400">import</span>
                    <span> os</span>
                  </div>
                  <div className="flex">
                    <span className="text-muted-foreground w-12 text-right pr-4">2</span>
                    <span className="text-purple-400">from</span>
                    <span> pathlib </span>
                    <span className="text-purple-400">import</span>
                    <span> Path</span>
                  </div>
                  <div className="flex">
                    <span className="text-muted-foreground w-12 text-right pr-4">3</span>
                    <span></span>
                  </div>
                  <div className="flex">
                    <span className="text-muted-foreground w-12 text-right pr-4">4</span>
                    <span className="text-purple-400">def</span>
                    <span className="text-blue-400"> process_files</span>
                    <span>(directory: </span>
                    <span className="text-green-400">str</span>
                    <span>):</span>
                  </div>
                  <div className="flex">
                    <span className="text-muted-foreground w-12 text-right pr-4">5</span>
                    <span className="pl-8 text-muted-foreground">"""Process files in directory."""</span>
                  </div>
                  <div className="flex">
                    <span className="text-muted-foreground w-12 text-right pr-4">6</span>
                    <span className="pl-8">path = Path(directory)</span>
                  </div>
                  <div className="flex">
                    <span className="text-muted-foreground w-12 text-right pr-4">7</span>
                    <span className="pl-8"></span>
                    <span className="border-l-2 border-primary animate-pulse"></span>
                  </div>
                </div>
              </div>
            </div>
            <div className="border-t bg-card p-2 flex items-center justify-between text-xs text-muted-foreground">
              <div className="flex items-center gap-4">
                <span>Ln 7, Col 5</span>
                <span>UTF-8</span>
                <span>Python 3.11</span>
              </div>
              <div className="flex items-center gap-2">
                <Sparkles className="size-3 text-primary" />
                <span>AI completions active</span>
              </div>
            </div>
          </div>
        )}

        {/* Image Generation View */}
        {activeView === 'image' && (
          <div className="flex-1 flex">
            <div className="flex-1 flex flex-col p-6">
              <div className="max-w-5xl mx-auto w-full space-y-6">
                {/* Prompt Input */}
                <Card>
                  <CardContent className="p-4 space-y-3">
                    <div className="flex gap-2">
                      <Textarea
                        placeholder="Describe the image you want to generate..."
                        className="min-h-[80px] resize-none"
                        defaultValue="A serene mountain landscape at sunset, with snow-capped peaks reflecting in a crystal-clear lake, photorealistic style"
                      />
                      <Button className="shrink-0 self-end">
                        <Wand2 className="size-4 mr-2" />
                        Generate
                      </Button>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Sparkles className="size-3" />
                      <span>Using Stable Diffusion XL • ComfyUI Backend</span>
                    </div>
                  </CardContent>
                </Card>

                {/* Generated Images */}
                <div className="grid grid-cols-2 gap-4">
                  {[1, 2, 3, 4].map((i) => (
                    <Card key={i} className="overflow-hidden group cursor-pointer hover:shadow-lg transition-shadow">
                      <div className="aspect-square bg-gradient-to-br from-purple-400/20 to-blue-400/20 flex items-center justify-center relative">
                        <Image className="size-16 text-muted-foreground/20" />
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center">
                          <Button
                            variant="secondary"
                            size="sm"
                            className="opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <Download className="size-4 mr-2" />
                            Save
                          </Button>
                        </div>
                      </div>
                      <CardContent className="p-3">
                        <p className="text-xs text-muted-foreground line-clamp-2">
                          Mountain landscape at sunset, photorealistic
                        </p>
                        <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                          <Clock className="size-3" />
                          <span>2 min ago</span>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            </div>

            <div className="w-64 border-l bg-card p-4 space-y-4">
              <div>
                <h3 className="text-sm mb-3">Settings</h3>
                <div className="space-y-3">
                  <div>
                    <label className="text-xs text-muted-foreground">Model</label>
                    <Button variant="outline" size="sm" className="w-full justify-between mt-1">
                      <span className="text-xs">SDXL 1.0</span>
                      <ChevronDown className="size-3" />
                    </Button>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">Steps: 30</label>
                    <div className="h-1 bg-accent rounded-full mt-2">
                      <div className="h-full w-3/5 bg-primary rounded-full" />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">CFG Scale: 7.5</label>
                    <div className="h-1 bg-accent rounded-full mt-2">
                      <div className="h-full w-1/2 bg-primary rounded-full" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Model Library View */}
        {activeView === 'models' && (
          <div className="flex-1 flex flex-col p-6">
            <div className="max-w-5xl mx-auto w-full space-y-6">
              {/* Search */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                <Input placeholder="Search models..." className="pl-10" />
              </div>

              {/* Recommended Models */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Sparkles className="size-4 text-primary" />
                  <h3 className="text-sm">Recommended for Your Hardware</h3>
                </div>
                <div className="grid gap-3">
                  {[
                    {
                      name: 'llama3.2:8b',
                      size: '4.9GB',
                      params: '8B',
                      score: 95,
                      downloaded: true,
                      desc: 'Best all-around performance for your system',
                    },
                    {
                      name: 'codellama:13b',
                      size: '7.4GB',
                      params: '13B',
                      score: 88,
                      downloaded: false,
                      desc: 'Optimized for code generation and review',
                    },
                    {
                      name: 'mistral:7b',
                      size: '4.1GB',
                      params: '7B',
                      score: 92,
                      downloaded: true,
                      desc: 'Fast inference with excellent reasoning',
                    },
                  ].map((model) => (
                    <Card key={model.name} className="hover:shadow-md transition-shadow">
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-2">
                              <h4>{model.name}</h4>
                              {model.downloaded && (
                                <Badge variant="secondary" className="text-xs">
                                  Installed
                                </Badge>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground mb-3">{model.desc}</p>
                            <div className="flex items-center gap-4 text-xs text-muted-foreground">
                              <div className="flex items-center gap-1">
                                <HardDrive className="size-3" />
                                <span>{model.size}</span>
                              </div>
                              <div className="flex items-center gap-1">
                                <Cpu className="size-3" />
                                <span>{model.params} params</span>
                              </div>
                              <div className="flex items-center gap-1">
                                <Zap className="size-3 text-primary" />
                                <span>Score: {model.score}/100</span>
                              </div>
                            </div>
                          </div>
                          <div className="flex gap-2">
                            {model.downloaded ? (
                              <>
                                <Button variant="outline" size="sm">
                                  Use
                                </Button>
                                <Button variant="ghost" size="icon" className="size-8">
                                  <Trash2 className="size-4" />
                                </Button>
                              </>
                            ) : (
                              <Button size="sm">
                                <Download className="size-4 mr-2" />
                                Download
                              </Button>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>

              {/* All Models */}
              <div className="mt-8">
                <h3 className="text-sm mb-3">Browse All Models</h3>
                <div className="grid gap-3">
                  {[
                    { name: 'llama3.2:70b', size: '39GB', params: '70B', downloaded: false },
                    { name: 'gemma:7b', size: '4.8GB', params: '7B', downloaded: false },
                    { name: 'phi3:3.8b', size: '2.3GB', params: '3.8B', downloaded: false },
                  ].map((model) => (
                    <Card key={model.name}>
                      <CardContent className="p-3 flex items-center justify-between">
                        <div className="flex items-center gap-4">
                          <div>
                            <h4 className="text-sm">{model.name}</h4>
                            <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1">
                              <span>{model.size}</span>
                              <span>•</span>
                              <span>{model.params} params</span>
                            </div>
                          </div>
                        </div>
                        <Button variant="outline" size="sm">
                          <Download className="size-4 mr-2" />
                          Download
                        </Button>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
