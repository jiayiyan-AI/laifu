import { useState } from 'react';
import { ThreadList } from './ThreadList.js';
import { Conversation } from './Conversation.js';

export const ChatApp = () => {
  const [active, setActive] = useState<string | null>(null);

  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      <ThreadList selected={active} onSelect={setActive} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {active
          // key={active} 强制 Conversation 重挂载,触发其 useEffect 重拉历史
          ? <Conversation key={active} threadId={active} />
          : <div className="dim" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13 }}>左侧选一个对话或新建一个</div>
        }
      </div>
    </div>
  );
};
