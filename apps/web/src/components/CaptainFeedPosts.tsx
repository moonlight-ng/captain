import type { FeedPost } from "../feed-posts";
import { timestampLabel } from "../format";

function authorLabel(author: FeedPost["author"]): string {
  return author === "traveller" ? "You" : "Captain";
}

function FeedAvatar({ author }: { author: FeedPost["author"] }) {
  if (author === "captain") {
    return (
      <img
        className="feed-post-avatar"
        src="/captain-avatar.jpg"
        alt=""
        aria-hidden="true"
      />
    );
  }

  return (
    <span className="feed-post-avatar is-traveller" aria-hidden="true">
      Y
    </span>
  );
}

export function CaptainFeedPosts({ posts }: { posts: FeedPost[] }) {
  if (posts.length === 0) return null;

  return (
    <div className="feed-posts">
      {posts.map((post) => (
        <article
          className={`feed-post${post.kind === "update" ? " is-update" : ""}`}
          key={post.id}
        >
          <FeedAvatar author={post.author} />
          <div className="feed-post-body">
            <header className="feed-post-header">
              <strong>{authorLabel(post.author)}</strong>
              <small>
                {timestampLabel(post.createdAt)}
                {post.channel === "telegram" ? " · Telegram" : ""}
              </small>
            </header>
            <p>{post.body}</p>
            {post.action ? (
              <button type="button" className="quiet-link" onClick={post.action.onClick}>
                {post.action.label}
              </button>
            ) : null}
          </div>
        </article>
      ))}
    </div>
  );
}
