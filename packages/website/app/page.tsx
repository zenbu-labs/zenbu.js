import { ApiPopover } from "./api-popover";
import { ContactLink } from "./contact-link";
import { DocsLink } from "./docs-link";
import { DownloadPopover } from "./download-popover";
import { InstallCommand } from "./install-command";

export const metadata = {
  title: "Zenbu.js",
  description:
    "Zenbu.js is a JavaScript framework for building hackable software.",
};

export default function Home() {
  return (
    <div className="flex flex-col">
      <main className="flex flex-col items-center px-6">
        {/* Hero */}
        <div className="max-w-lg w-full pt-16 sm:pt-24">
          <div className="flex items-end gap-3">
            <img src="/logo.png" alt="" className="[image-rendering:pixelated] h-11 w-auto" />
            <h1 className="text-[2.5rem] sm:text-[2.75rem] font-semibold tracking-tight leading-[0.8]">
              Zenbu.js
            </h1>
          </div>

          <p className="mt-8 mb-6 text-[17px] text-zinc-500 leading-relaxed">
            The framework for building <span className="text-zinc-900">hackable</span> software.
          </p>

          {/* Install */}
          <InstallCommand />

          {/* Links */}
          <div className="mt-6 flex items-center gap-4 text-sm">
            <DocsLink />
            <DownloadPopover />
          </div>
        </div>

        {/* --- What --- */}
        <div className="max-w-lg w-full mt-20">
          <h2 className="text-lg font-semibold tracking-tight">
            Everything is editable
          </h2>
          <div className="mt-4 space-y-4 text-[15px] text-zinc-500 leading-[1.75]">
            <p>
              When you ship a Zenbu.js app to production, the raw source code
              comes with it. Users can use their coding agent to edit and
              customize the app to fit their needs.
            </p>
          </div>
        </div>

        {/* --- How --- */}
        <div className="max-w-lg w-full mt-12">
          <h2 className="text-lg font-semibold tracking-tight">
            Extensible by default
          </h2>
          <div className="mt-4 space-y-4 text-[15px] text-zinc-500 leading-[1.75]">
            <p>
              Zenbu.js provides a plugin system for your app out of the box,
              giving your users the ability to build new features and share them
              with each other.
            </p>
          </div>
        </div>

        {/* --- Under the hood --- */}
        <div className="max-w-lg w-full mt-12">
          <h2 className="text-lg font-semibold tracking-tight">
            Lean but powerful core
          </h2>
          <div className="mt-4 space-y-4 text-[15px] text-zinc-500 leading-[1.75]">
            <span>
              Type safe <ApiPopover /> to reduce complexity and keep your apps
              performant..
            </span>
          </div>
        </div>

        {/* Links */}
        <div className="max-w-lg w-full mt-16 flex items-center gap-3">
          <a
            href="https://github.com/zenbu-labs/zenbu.js"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 text-white pl-4 pr-3.5 py-2 text-sm font-medium hover:bg-zinc-800 transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
            </svg>
            GitHub
          </a>
          <a
            href="https://discord.gg/t3jzHHfc6z"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-600 hover:border-zinc-300 hover:text-zinc-800 transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
            </svg>
            Discord
          </a>
        </div>

        {/* --- FAQ --- */}
        <div className="max-w-lg w-full mt-20 mb-16">
          <h2 className="text-lg font-semibold tracking-tight">FAQ</h2>
          <div className="mt-6 divide-y divide-zinc-200">
            <details className="group py-4 first:pt-0">
              <summary className="flex cursor-pointer items-center justify-between text-[15px] font-medium text-zinc-900 [&::-webkit-details-marker]:hidden list-none">
                What happens if a user edits the app and it conflicts with a
                future update?
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="shrink-0 ml-4 text-zinc-400 transition-transform group-open:rotate-45"
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </summary>
              <div className="mt-3 space-y-3 text-[15px] text-zinc-500 leading-[1.75]">
                <p>
                  The source code on the user's device is tracked by git, so you
                  can alert them when there's a conflict. In practice users can have their coding agent resolve
                  conflicts.
                </p>
                <p>
                  Users also have the option to make changes only via plugins,
                  which can never have merge conflicts.
                </p>
              </div>
            </details>
            <details className="group py-4">
              <summary className="flex cursor-pointer items-center justify-between text-[15px] font-medium text-zinc-900 [&::-webkit-details-marker]:hidden list-none">
                How does my app become extensible?
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="shrink-0 ml-4 text-zinc-400 transition-transform group-open:rotate-45"
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </summary>
              <div className="mt-3 text-[15px] text-zinc-500 leading-[1.75]">
                <p>
                  Zenbu.js organizes your app so new code can be loaded into
                  your application. The APIs are designed with the expectation
                  that new unknown code will want to plug into your application
                  to access and modify functionality you defined.
                </p>
              </div>
            </details>
            <details className="group py-4">
              <summary className="flex cursor-pointer items-center justify-between text-[15px] font-medium text-zinc-900 [&::-webkit-details-marker]:hidden list-none">
                Do I need to use Electron?
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="shrink-0 ml-4 text-zinc-400 transition-transform group-open:rotate-45"
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </summary>
              <div className="mt-3 text-[15px] text-zinc-500 leading-[1.75]">
                <p>
                  For now, yes. But support for other runtimes like Tauri and
                  pure Node.js is coming soon.
                </p>
              </div>
            </details>
            <details className="group py-4">
              <summary className="flex cursor-pointer items-center justify-between text-[15px] font-medium text-zinc-900 [&::-webkit-details-marker]:hidden list-none">
                Is it ready for production usage?
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="shrink-0 ml-4 text-zinc-400 transition-transform group-open:rotate-45"
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </summary>
              <div className="mt-3 text-[15px] text-zinc-500 leading-[1.75]">
                <p>It's not yet ready, Zenbu.js is still in alpha.</p>
              </div>
            </details>
          </div>
        </div>
      </main>

      <footer className="border-t border-zinc-200/60 px-6 py-5">
        <div className="max-w-lg mx-auto flex items-center justify-between text-xs text-zinc-400">
          <span>Zenbu Labs</span>
          <ContactLink className="hover:text-zinc-600 transition-colors" />
        </div>
      </footer>
    </div>
  );
}
